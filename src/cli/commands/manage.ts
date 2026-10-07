import { readFileSync } from "node:fs";
import path from "node:path";
import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { c, out, printJson } from "../output.ts";
import { ApiError, type PatchTaskInput } from "../api-client.ts";
import { COLUMNS } from "../../shared/types.ts";
import { flagValue } from "../args.ts";
import { usageError } from "../usage.ts";

const COLUMN_IDS = COLUMNS.map((col) => col.id);
const SCHEDULED_ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,3})?)?(Z|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)$/i;

export function parseScheduledIsoDate(value: string): number {
  const match = SCHEDULED_ISO_RE.exec(value);
  if (!match) {
    throw new Error("scheduled time must be ISO-8601 with a valid date, time, and explicit UTC offset");
  }
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year
    || calendarDate.getUTCMonth() !== month - 1
    || calendarDate.getUTCDate() !== day
  ) {
    throw new Error(`invalid ISO-8601 date: ${value}`);
  }
  const runAt = Date.parse(value);
  if (!Number.isSafeInteger(runAt) || !Number.isFinite(runAt)) {
    throw new Error(`invalid ISO-8601 date: ${value}`);
  }
  return runAt;
}

export async function cmdEdit(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) throw usageError("edit");
  const patch: PatchTaskInput = {};
  let detachProfile = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    const val = (allowDash = false) => flagValue(args, ++i, a, allowDash);
    switch (a) {
      case "--title": patch.title = val(); break;
      case "--prompt": patch.prompt = val(); break;
      case "--prompt-file": {
        const f = val(true);
        patch.prompt = f === "-" ? (await Bun.stdin.text()).trim() : readFileSync(f, "utf8");
        break;
      }
      case "--agent": patch.agent = val(); break;
      // Resolve relative to the CLI's cwd, matching `add`/`projects add` —
      // the daemon that ultimately runs git ops may have a different cwd.
      case "--workdir": patch.workdir = path.resolve(val()); break;
      case "--model": patch.model = val(); break;
      case "--mode": patch.mode = val(); break;
      case "--effort": patch.effort = val(); break;
      case "--fast": patch.fast = true; break;
      case "--no-fast": patch.fast = false; break;
      case "--max-mode": patch.maxMode = true; break;
      case "--no-max-mode": patch.maxMode = false; break;
      case "--type": patch.taskType = val(); break;
      case "--column": patch.column = val(); break;
      case "--detach-profile": detachProfile = true; break;
      default: break;
    }
  }
  if (Object.keys(patch).length === 0 && !detachProfile) {
    throw new Error(
      "nothing to edit — pass at least one of --title/--prompt/--agent/--workdir/--model/--mode/--effort/--fast/--no-fast/--max-mode/--no-max-mode/--type/--column/--detach-profile",
    );
  }
  if (patch.column && !COLUMN_IDS.includes(patch.column as (typeof COLUMN_IDS)[number])) {
    throw new Error(`unknown column "${patch.column}" — one of: ${COLUMN_IDS.join(", ")}`);
  }
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  // Detach first so a combined `--detach-profile --model …` unlocks the
  // bound fields before the patch that wants to change them — the server
  // 409s a PATCH that touches agent/mode/model/effort/fast/maxMode while
  // still bound. That 409's message says "agent" (the server's own
  // vocabulary — "agent" = harness there), which would read as nonsense at
  // the CLI boundary where "agent" = harness and "profile" = agent profile
  // (docs/plans/task-details-agent-row.md D4); rewrite it in place rather
  // than change the server string, which the webview also reads verbatim.
  // Every other error this command can raise still propagates unmodified.
  let updated = detachProfile ? await client.detachTaskAgentProfile(task.id) : task;
  if (Object.keys(patch).length > 0) {
    try {
      updated = await client.patchTask(updated.id, patch);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.message.startsWith("task is bound to agent")) {
        const rewritten = err.message.replace(/^task is bound to agent/, "task is bound to profile");
        throw new Error(`${rewritten} (agetor edit ${task.id.slice(0, 8)} --detach-profile)`);
      }
      throw err;
    }
  }
  if (flags.json) return printJson(updated);
  // model/mode/effort changes are forwarded to a live claude session by the
  // server (reconcileTaskSession sends /model, /effort, cycles mode).
  const changed = [...(detachProfile ? ["detach-profile"] : []), ...Object.keys(patch)];
  out(`${c.green("✓")} updated ${c.dim(updated.id.slice(0, 8))} — ${changed.join(", ")}`);
}

export async function cmdMove(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  const column = args[1];
  if (!ref || !column) {
    throw usageError("move");
  }
  if (!COLUMN_IDS.includes(column as (typeof COLUMN_IDS)[number])) {
    throw new Error(`unknown column "${column}" — one of: ${COLUMN_IDS.join(", ")}`);
  }
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const updated = await client.patchTask(task.id, { column });
  if (flags.json) return printJson(updated);
  out(`${c.cyan("→")} moved ${c.dim(updated.id.slice(0, 8))} → ${column}`);
}

export async function cmdSchedule(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  const isoDate = args[1];
  if (!ref || !isoDate) throw usageError("schedule");
  let timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  for (let i = 2; i < args.length; i++) {
    if (args[i] !== "--timezone" || !args[i + 1]) {
      throw usageError("schedule");
    }
    timeZone = args[++i]!;
  }
  const runAt = parseScheduledIsoDate(isoDate);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(runAt);
  } catch {
    throw new Error(`invalid IANA time zone: ${timeZone}`);
  }
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const updated = await client.scheduleTask(task.id, runAt, timeZone);
  if (flags.json) return printJson(updated);
  const scheduledLabel = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(runAt);
  out(`${c.green("✓")} scheduled ${c.dim(updated.id.slice(0, 8))} — ${scheduledLabel} (${timeZone})`);
}

export async function cmdUnschedule(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) throw usageError("unschedule");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const updated = await client.cancelTaskSchedule(task.id);
  if (flags.json) return printJson(updated);
  out(
    updated.schedule?.status === "cancelled"
      ? `${c.gray("cancelled schedule")} ${c.dim(updated.id.slice(0, 8))}`
      : `${c.dim("no active schedule")} ${c.dim(updated.id.slice(0, 8))}`,
  );
}

export async function cmdArchive(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) throw usageError("archive");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const updated = await client.archiveTask(task.id);
  if (flags.json) return printJson(updated);
  out(`${c.gray("archived")} ${c.dim(updated.id.slice(0, 8))}`);
}

export async function cmdUnarchive(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) throw usageError("unarchive");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const updated = await client.unarchiveTask(task.id);
  if (flags.json) return printJson(updated);
  out(`${c.green("unarchived")} ${c.dim(updated.id.slice(0, 8))}`);
}
