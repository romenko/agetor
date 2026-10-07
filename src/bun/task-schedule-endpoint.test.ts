import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task } from "../shared/types.ts";

process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-schedule-endpoint-"));
process.env.AGETOR_API_PORT = "0";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";

let server: { stop: (closeActiveConnections?: boolean) => void; port: number };
let token: string;
let createTask: typeof import("./orchestrator.ts").createTask;
let tasks: typeof import("./db.ts").tasks;
let runs: typeof import("./db.ts").runs;
let db: typeof import("./db.ts").db;

beforeAll(async () => {
  ({ createTask } = await import("./orchestrator.ts"));
  ({ tasks, runs, db } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as typeof server;
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop(true);
});

const call = (taskId: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${server.port}/tasks/${encodeURIComponent(taskId)}/schedule`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

async function newTask(title: string): Promise<Task> {
  const created = await createTask({
    title,
    prompt: "noop",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  return created.task;
}

function addRun(taskId: string, status: "running" | "succeeded" | "failed") {
  const id = randomUUID();
  runs.insert({
    id,
    taskId,
    agent: "claude-code",
    status,
    startedAt: Date.now(),
    endedAt: status === "running" ? null : Date.now(),
    exitCode: status === "succeeded" ? 0 : status === "failed" ? 1 : null,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
  });
  return id;
}

test("schedule API validates, creates, reschedules, and cancels a one-shot schedule", async () => {
  const task = await newTask("schedule lifecycle");
  try {
    const invalidTime = await call(task.id, {
      method: "POST",
      body: JSON.stringify({ runAt: Date.now() - 1, timeZone: "UTC" }),
    });
    expect(invalidTime.status).toBe(400);

    const invalidZone = await call(task.id, {
      method: "POST",
      body: JSON.stringify({ runAt: Date.now() + 60_000, timeZone: "Mars/Olympus" }),
    });
    expect(invalidZone.status).toBe(400);

    const firstRunAt = Date.now() + 60_000;
    const first = await call(task.id, {
      method: "POST",
      body: JSON.stringify({ runAt: firstRunAt, timeZone: "Europe/Kiev" }),
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as Task).schedule).toMatchObject({
      runAt: firstRunAt,
      timeZone: "Europe/Kiev",
      status: "scheduled",
    });

    const secondRunAt = firstRunAt + 60_000;
    const rescheduled = await call(task.id, {
      method: "POST",
      body: JSON.stringify({ runAt: secondRunAt, timeZone: "UTC" }),
    });
    expect(((await rescheduled.json()) as Task).schedule).toMatchObject({
      runAt: secondRunAt,
      timeZone: "UTC",
      status: "scheduled",
    });
    expect(db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM task_schedules WHERE task_id = ?",
    ).get(task.id)?.count).toBe(1);

    const cancelled = await call(task.id, { method: "DELETE" });
    expect(((await cancelled.json()) as Task).schedule?.status).toBe("cancelled");
  } finally {
    db.run("DELETE FROM tasks WHERE id = ?", [task.id]);
  }
});

test("column changes, edits, archive, and delete keep schedule state consistent", async () => {
  const task = await newTask("schedule transitions");
  try {
    const runAt = Date.now() + 120_000;
    await call(task.id, {
      method: "POST",
      body: JSON.stringify({ runAt, timeZone: "UTC" }),
    });

    const edit = await fetch(`http://127.0.0.1:${server.port}/tasks/${task.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "renamed without cancelling" }),
    });
    expect(((await edit.json()) as Task).schedule?.status).toBe("scheduled");

    const movedToBacklog = await fetch(`http://127.0.0.1:${server.port}/tasks/${task.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ column: "backlog" }),
    });
    expect(((await movedToBacklog.json()) as Task).schedule?.status).toBe("scheduled");

    const movedToDone = await fetch(`http://127.0.0.1:${server.port}/tasks/${task.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ column: "done" }),
    });
    expect(((await movedToDone.json()) as Task).schedule?.status).toBe("skipped");

    const archived = await fetch(`http://127.0.0.1:${server.port}/tasks/${task.id}/archive`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    expect(archived.status).toBe(200);
    expect(((await archived.json()) as Task).schedule?.status).toBe("skipped");

    const deletedTask = await newTask("schedule cascade");
    await call(deletedTask.id, {
      method: "POST",
      body: JSON.stringify({ runAt: Date.now() + 120_000, timeZone: "UTC" }),
    });
    const deleted = await fetch(`http://127.0.0.1:${server.port}/tasks/${deletedTask.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleted.status).toBe(204);
    expect(tasks.schedule.get(deletedTask.id)).toBeNull();
  } finally {
    db.run("DELETE FROM tasks WHERE id = ?", [task.id]);
  }
});

test("schedule API rejects completed, active, archived, and claimed tasks", async () => {
  const done = await newTask("already done");
  const active = await newTask("already running");
  const archived = await newTask("archived");
  const claimed = await newTask("already claimed");
  try {
    tasks.update(done.id, { column: "done" });
    const activeRunId = addRun(active.id, "running");
    tasks.update(active.id, { column: "running", runId: activeRunId });
    tasks.update(archived.id, { archivedAt: Date.now() });

    const body = JSON.stringify({ runAt: Date.now() + 60_000, timeZone: "UTC" });
    for (const task of [done, active, archived]) {
      const response = await call(task.id, { method: "POST", body });
      expect(response.status).toBe(409);
    }

    await call(claimed.id, { method: "POST", body });
    const claimId = randomUUID();
    expect(tasks.schedule.claimDue(Date.now() + 120_000, claimId)).toHaveLength(1);
    const cancel = await call(claimed.id, { method: "DELETE" });
    expect(cancel.status).toBe(409);
  } finally {
    for (const task of [done, active, archived, claimed]) {
      db.run("DELETE FROM tasks WHERE id = ?", [task.id]);
    }
  }
});

test("manual start cancels the pending schedule and creates exactly one run", async () => {
  const task = await newTask("manual start beats schedule");
  try {
    await call(task.id, {
      method: "POST",
      body: JSON.stringify({ runAt: Date.now() + 60_000, timeZone: "UTC" }),
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/tasks/${task.id}/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    const result = await response.json() as { runId: string };
    expect(result.runId).toBeString();
    expect(tasks.schedule.get(task.id)).toMatchObject({
      status: "cancelled",
      error: "cancelled by manual start",
    });
    expect(db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM runs WHERE task_id = ?",
    ).get(task.id)?.count).toBe(1);
    await Bun.sleep(300);
  } finally {
    db.run("DELETE FROM tasks WHERE id = ?", [task.id]);
  }
});

test("overdue batch is claimed once and interrupted claims recover without reviving cancelled schedules", async () => {
  const batch = await Promise.all(Array.from({ length: 12 }, (_, i) => newTask(`due ${i}`)));
  try {
    for (const task of batch) tasks.schedule.set(task.id, Date.now() - 60_000, "UTC");
    tasks.schedule.cancel(batch[0]!.id);
    const first = tasks.schedule.claimDue(Date.now(), "before-restart");
    const second = tasks.schedule.claimDue(Date.now(), "before-restart");
    expect(first).toHaveLength(10);
    expect(second).toHaveLength(1);
    expect(new Set([...first, ...second].map((item) => item.taskId)).size).toBe(11);
    expect(tasks.schedule.claimDue(Date.now(), "duplicate")).toEqual([]);
    expect(tasks.schedule.rearmClaimed()).toBe(11);
    expect(tasks.schedule.ownsClaim(batch[1]!.id, "before-restart")).toBe(false);
    expect(tasks.schedule.claimDue(Date.now(), "after-restart")).toHaveLength(10);
    expect(tasks.schedule.claimDue(Date.now(), "after-restart")).toHaveLength(1);
    expect(tasks.schedule.get(batch[0]!.id)?.status).toBe("cancelled");
  } finally {
    for (const task of batch) tasks.delete(task.id);
  }
});

test("failure before run creation is terminal; failure after commit preserves the run association", async () => {
  const before = await newTask("failure before run");
  const after = await newTask("failure after run");
  try {
    for (const task of [before, after]) tasks.schedule.set(task.id, 1, "UTC");
    expect(tasks.schedule.claimDue(Date.now(), "claim")).toHaveLength(2);
    tasks.schedule.fail(before.id, "wrong-claim", "stale failure");
    expect(tasks.schedule.get(before.id)?.status).toBe("claimed");
    tasks.schedule.fail(before.id, "claim", "spawn preparation failed");
    db.transaction(() => {
      const runId = addRun(after.id, "failed");
      tasks.schedule.complete(after.id, "claim", runId);
    })();
    const completed = tasks.schedule.get(after.id);
    tasks.schedule.fail(after.id, "claim", "late failure");
    expect(tasks.schedule.get(before.id)).toMatchObject({ status: "failed", runId: null });
    expect(tasks.schedule.get(after.id)).toEqual(completed);
    expect(completed?.status).toBe("started");
    expect(completed?.runId).toBeString();
    expect(tasks.schedule.rearmClaimed()).toBe(0);
    expect(tasks.schedule.claimDue(Date.now(), "retry")).toEqual([]);
  } finally {
    tasks.delete(before.id);
    tasks.delete(after.id);
  }
});

test("rescheduling, archiving and manual cancellation invalidate stale claims", async () => {
  const task = await newTask("stale schedule");
  try {
    tasks.schedule.set(task.id, 1, "UTC");
    tasks.schedule.set(task.id, Date.now() + 60_000, "UTC");
    expect(tasks.schedule.claimDue(Date.now(), "old-time")).toEqual([]);
    tasks.schedule.set(task.id, 1, "UTC");
    expect(tasks.schedule.claimDue(Date.now(), "old-claim")).toHaveLength(1);
    tasks.schedule.cancelForManualStart(task.id);
    const { startTask } = await import("./orchestrator.ts");
    expect(await startTask(task.id, { scheduleClaimId: "old-claim" })).toHaveProperty("error");
    expect(db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM runs WHERE task_id = ?",
    ).get(task.id)?.count).toBe(0);
    tasks.schedule.set(task.id, Date.now() + 60_000, "UTC");
    const response = await fetch(`http://127.0.0.1:${server.port}/tasks/${task.id}/archive`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    expect(response.status).toBe(200);
    expect(tasks.schedule.get(task.id)?.status).toBe("skipped");
    expect(tasks.schedule.claimDue(Date.now() + 120_000, "archived")).toEqual([]);
  } finally {
    tasks.delete(task.id);
  }
});

test("scheduler catches up after downtime and restarting it does not start a second run", async () => {
  const { initTaskScheduler, stopTaskScheduler } = await import("./task-scheduler.ts");
  const task = await newTask("scheduler catch-up");
  try {
    tasks.schedule.set(task.id, Date.now() - 60_000, "UTC");
    tasks.schedule.claimDue(Date.now(), "interrupted-process");
    expect(initTaskScheduler()).toBe(1);
    for (let i = 0; i < 100 && tasks.schedule.get(task.id)?.status === "claimed"; i++) {
      await Bun.sleep(20);
    }
    expect(tasks.schedule.get(task.id)?.status).toBe("started");
    stopTaskScheduler();
    expect(initTaskScheduler()).toBe(0);
    await Bun.sleep(1100);
    expect(db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM runs WHERE task_id = ?",
    ).get(task.id)?.count).toBe(1);
  } finally {
    stopTaskScheduler();
    tasks.delete(task.id);
  }
});

test("manual and scheduled starts racing for the same task create only one run", async () => {
  const { initTaskScheduler, stopTaskScheduler } = await import("./task-scheduler.ts");
  const task = await newTask("manual and scheduler race");
  try {
    tasks.schedule.set(task.id, Date.now() + 20, "UTC");
    initTaskScheduler();
    await Bun.sleep(25);
    const response = await fetch(`http://127.0.0.1:${server.port}/tasks/${task.id}/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect([200, 409]).toContain(response.status);
    await Bun.sleep(1_150);
    expect(db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM runs WHERE task_id = ?",
    ).get(task.id)?.count).toBe(1);
  } finally {
    stopTaskScheduler();
    tasks.delete(task.id);
  }
});

test("scheduled launch failure before a run is created is reported as failed", async () => {
  const { initTaskScheduler, stopTaskScheduler } = await import("./task-scheduler.ts");
  const task = await newTask("scheduler pre-launch failure");
  try {
    tasks.update(task.id, { agent: "missing-harness" });
    tasks.schedule.set(task.id, Date.now() - 60_000, "UTC");
    initTaskScheduler();
    for (
      let i = 0;
      i < 100 && ["scheduled", "claimed"].includes(tasks.schedule.get(task.id)?.status ?? "");
      i++
    ) {
      await Bun.sleep(20);
    }
    expect(tasks.schedule.get(task.id)).toMatchObject({ status: "failed", runId: null });
    expect(db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM runs WHERE task_id = ?",
    ).get(task.id)?.count).toBe(0);
  } finally {
    stopTaskScheduler();
    tasks.delete(task.id);
  }
});
