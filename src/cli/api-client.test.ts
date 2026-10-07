import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureCore, stopDaemon } from "./daemon/supervisor.ts";
import { AgetorClient, ApiError, discoverCore } from "./api-client.ts";
import { coreCredsPath } from "../bun/core-creds.ts";
import { makeTask } from "./test-fixtures.ts";

test("schedule methods encode task IDs and preserve request bodies", async () => {
  const captured: unknown[] = [];
  const task = makeTask({ id: "t 1" });
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      captured.push([req.method, new URL(req.url).pathname, await req.text()]);
      return Response.json(task);
    },
  });
  try {
    const client = new AgetorClient({ port: server.port!, token: "tok" });
    expect(await client.scheduleTask("t 1", 123, "UTC")).toEqual(task);
    expect(await client.cancelTaskSchedule("t 1")).toEqual(task);
    expect(captured).toEqual([
      ["POST", "/tasks/t%201/schedule", JSON.stringify({ runAt: 123, timeZone: "UTC" })],
      ["DELETE", "/tasks/t%201/schedule", ""],
    ]);
  } finally {
    server.stop(true);
  }
});

test("discoverCore returns null when no core is running", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-disc-"));
  expect(await discoverCore(dir)).toBeNull();
});

test("api-client task round-trip + ApiError on 404", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-apic-"));
  const core = await ensureCore({ dataDir: dir, port: 4494 });
  const client = new AgetorClient(core);
  try {
    // createTask returns the BARE Task (regression guard for the {task} bug).
    const task = await client.createTask({
      title: "Round-trip",
      prompt: "p",
      agent: "claude-code",
      isolation: "none",
      workdir: dir,
    });
    expect(typeof task.id).toBe("string");
    expect(task.title).toBe("Round-trip");
    expect(task.column).toBe("backlog");

    expect((await client.getTask(task.id)).id).toBe(task.id);
    expect(await client.listTasks()).toHaveLength(1);

    let err: unknown;
    try {
      await client.getTask("does-not-exist");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);

    await client.deleteTask(task.id);
    expect(await client.listTasks()).toHaveLength(0);
  } finally {
    await stopDaemon(dir);
    for (let i = 0; i < 30 && existsSync(coreCredsPath(dir)); i++) {
      await Bun.sleep(100);
    }
  }
}, 30_000);

test("a restarted headless core re-arms an interrupted schedule and starts it once", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-schedule-restart-"));
  const previousDriver = process.env.AGETOR_CLAUDE_DRIVER;
  const previousBin = process.env.AGETOR_CLAUDE_BIN;
  const previousTmux = process.env.AGETOR_TMUX_BIN;
  process.env.AGETOR_CLAUDE_DRIVER = "fake";
  process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
  process.env.AGETOR_TMUX_BIN = "/bin/echo";
  try {
    const firstCore = await ensureCore({ dataDir: dir, port: 4499 });
    const firstClient = new AgetorClient(firstCore);
    const task = await firstClient.createTask({
      title: "restart scheduled task",
      prompt: "p",
      agent: "claude-code",
      isolation: "none",
      workdir: dir,
    });
    await firstClient.scheduleTask(task.id, Date.now() + 60_000, "UTC");
    await stopDaemon(dir);
    for (let i = 0; i < 30 && existsSync(coreCredsPath(dir)); i++) await Bun.sleep(100);

    const db = new Database(path.join(dir, "agetor.sqlite"));
    try {
      db.run(
        `UPDATE task_schedules
            SET run_at = ?, status = 'claimed', claim_id = 'interrupted', run_id = NULL
          WHERE task_id = ?`,
        [Date.now() - 60_000, task.id],
      );
    } finally {
      db.close();
    }

    const restartedCore = await ensureCore({ dataDir: dir, port: 4499 });
    const restartedClient = new AgetorClient(restartedCore);
    let current = await restartedClient.getTask(task.id);
    for (let i = 0; i < 100 && current.schedule?.status !== "started"; i++) {
      await Bun.sleep(50);
      current = await restartedClient.getTask(task.id);
    }
    expect(current.schedule).toMatchObject({ status: "started" });
    const runs = await restartedClient.getRuns(task.id);
    expect(runs).toHaveLength(1);
  } finally {
    await stopDaemon(dir);
    if (previousDriver === undefined) delete process.env.AGETOR_CLAUDE_DRIVER;
    else process.env.AGETOR_CLAUDE_DRIVER = previousDriver;
    if (previousBin === undefined) delete process.env.AGETOR_CLAUDE_BIN;
    else process.env.AGETOR_CLAUDE_BIN = previousBin;
    if (previousTmux === undefined) delete process.env.AGETOR_TMUX_BIN;
    else process.env.AGETOR_TMUX_BIN = previousTmux;
  }
}, 30_000);

// `resumeFxRecovery` (docs/plans/fix-fx-harness-rate-limit.md §3.5) — request
// shape (method/path/no-body) against a bare `Bun.serve` stub standing in for
// the core, since the real `/tasks/:id/fx-resume` route needs a genuinely
// paused fx recovery to answer `{ok:true}` (that end-to-end path belongs to
// `fx-resume-endpoint.test.ts`); this suite only pins what the CLIENT sends
// and how it parses what comes back.
test("resumeFxRecovery: issues POST /tasks/<url-encoded id>/fx-resume with no body, and parses {ok:true, runId}", async () => {
  let captured: { method: string; pathname: string; contentType: string | null; body: string } | null = null;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      captured = {
        method: req.method,
        pathname: url.pathname,
        contentType: req.headers.get("content-type"),
        body: await req.text(),
      };
      return new Response(JSON.stringify({ ok: true, runId: "run123456" }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    const client = new AgetorClient({ port: server.port!, token: "tok" });
    const res = await client.resumeFxRecovery("t 1");
    expect(res).toEqual({ ok: true, runId: "run123456" });
    expect(captured).not.toBeNull();
    expect(captured!.method).toBe("POST");
    // The space in the task id must be percent-encoded into the path — a raw
    // space would produce an invalid request line.
    expect(captured!.pathname).toBe("/tasks/t%201/fx-resume");
    // No body/content-type: `resumeFxRecovery` calls `req()` with no third
    // argument, so `AgetorClient`'s body-presence check (`body !== undefined`)
    // must not synthesize an empty JSON body.
    expect(captured!.contentType).toBeNull();
    expect(captured!.body).toBe("");
  } finally {
    server.stop(true);
  }
});

// A 400 `{error}` response — the shape every gating failure in
// `resumeFxRecovery` (orchestrator.ts) returns — rejects as an `ApiError`
// carrying that exact message, mirroring the file's existing 404 assertion
// above. Driven against a real daemon + a genuine (non-fx) task so this is
// the server's real error text, not a stub's guess.
test("resumeFxRecovery: a 400 {error} response rejects with that message", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-fxresume-"));
  const core = await ensureCore({ dataDir: dir, port: 4496 });
  const client = new AgetorClient(core);
  try {
    const t = await client.createTask({
      title: "Not fx",
      prompt: "p",
      agent: "claude-code",
      isolation: "none",
      workdir: dir,
    });

    let err: unknown;
    try {
      await client.resumeFxRecovery(t.id);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).message).toBe("only fx tasks can resume a paused response");
  } finally {
    await stopDaemon(dir);
    for (let i = 0; i < 30 && existsSync(coreCredsPath(dir)); i++) {
      await Bun.sleep(100);
    }
  }
}, 30_000);

// `cancelFxAutoResume` (docs/plans/fx-recovery-follow-ups.md §3.4/T6) —
// mirrors `resumeFxRecovery`'s two-test shape immediately above: a stub
// `Bun.serve` pins the request METHOD/PATH/parse contract, a real daemon +
// a genuine (non-paused) task pins the server's actual 400 error text.
test("cancelFxAutoResume: issues DELETE /tasks/<url-encoded id>/fx-auto-resume with no body, and parses {ok:true}", async () => {
  let captured: { method: string; pathname: string; contentType: string | null; body: string } | null = null;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      captured = {
        method: req.method,
        pathname: url.pathname,
        contentType: req.headers.get("content-type"),
        body: await req.text(),
      };
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    const client = new AgetorClient({ port: server.port!, token: "tok" });
    const res = await client.cancelFxAutoResume("t 1");
    expect(res).toEqual({ ok: true });
    expect(captured).not.toBeNull();
    expect(captured!.method).toBe("DELETE");
    // The space in the task id must be percent-encoded into the path — a raw
    // space would produce an invalid request line.
    expect(captured!.pathname).toBe("/tasks/t%201/fx-auto-resume");
    // No body/content-type: `cancelFxAutoResume` calls `req()` with no third
    // argument, so `AgetorClient`'s body-presence check (`body !== undefined`)
    // must not synthesize an empty JSON body.
    expect(captured!.contentType).toBeNull();
    expect(captured!.body).toBe("");
  } finally {
    server.stop(true);
  }
});

// A 400 `{error}` response — the shape the route (`server.ts`'s
// `/tasks/:id/fx-auto-resume` DELETE handler) returns when
// `cancelFxAutoResume(taskId, "cancelled")` finds no pending timer — rejects
// as an `ApiError` carrying that exact message. Driven against a real daemon
// + a genuine (non-fx, never-paused) task, so this is the server's real
// error text, not a stub's guess — mirrors the `resumeFxRecovery` 400 test.
test("cancelFxAutoResume: a 400 {error} response (no auto-resume pending) rejects with that message", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-fxcancel-"));
  const core = await ensureCore({ dataDir: dir, port: 4497 });
  const client = new AgetorClient(core);
  try {
    const t = await client.createTask({
      title: "Not paused",
      prompt: "p",
      agent: "claude-code",
      isolation: "none",
      workdir: dir,
    });

    let err: unknown;
    try {
      await client.cancelFxAutoResume(t.id);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).message).toBe("no auto-resume pending");
  } finally {
    await stopDaemon(dir);
    for (let i = 0; i < 30 && existsSync(coreCredsPath(dir)); i++) {
      await Bun.sleep(100);
    }
  }
}, 30_000);

// A 404 for an unknown task id — the route's other error branch (`!tasks.get(taskId)`).
test("cancelFxAutoResume: a 404 response (unknown task id) rejects as ApiError with status 404", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-fxcancel404-"));
  const core = await ensureCore({ dataDir: dir, port: 4498 });
  const client = new AgetorClient(core);
  try {
    let err: unknown;
    try {
      await client.cancelFxAutoResume("does-not-exist");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  } finally {
    await stopDaemon(dir);
    for (let i = 0; i < 30 && existsSync(coreCredsPath(dir)); i++) {
      await Bun.sleep(100);
    }
  }
}, 30_000);

test("edit/move/archive/unarchive round-trip returns the bare Task", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-mng-"));
  const core = await ensureCore({ dataDir: dir, port: 4495 });
  const client = new AgetorClient(core);
  try {
    const t = await client.createTask({
      title: "Orig",
      prompt: "p",
      agent: "claude-code",
      isolation: "none",
      workdir: dir,
    });
    // PATCH returns the bare updated Task (same contract as createTask).
    const renamed = await client.patchTask(t.id, { title: "Renamed" });
    expect(renamed.id).toBe(t.id);
    expect(renamed.title).toBe("Renamed");
    expect((await client.patchTask(t.id, { column: "done" })).column).toBe("done");
    expect((await client.archiveTask(t.id)).archivedAt).not.toBeNull();
    expect((await client.unarchiveTask(t.id)).archivedAt).toBeNull();
    await client.deleteTask(t.id);
  } finally {
    await stopDaemon(dir);
    for (let i = 0; i < 30 && existsSync(coreCredsPath(dir)); i++) {
      await Bun.sleep(100);
    }
  }
}, 30_000);

// A `/bundle/*` 2xx that isn't a JSON object (a body cut off or garbled
// after the core committed) must not reach the printers as a raw string.
test("bundle calls: an unreadable 2xx rejects with the lost-answer message", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("{\"agents\": [", { status: 201, headers: { "content-type": "application/json" } }),
  });
  try {
    const client = new AgetorClient({ port: server.port!, token: "tok" });
    const err = await client.importBundle("{}").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toContain("the import may have run");
    expect((err as ApiError).message).toContain("agetor profile ls");
    const preview = await client.previewBundleImport("{}").then(
      () => null,
      (e: unknown) => e,
    );
    expect((preview as ApiError).message).toBe("the core's answer to the preview was lost — try again");
    const exported = await client.exportBundle({ all: true }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((exported as ApiError).message).toBe("the core's answer to the export was lost — try again");
  } finally {
    server.stop(true);
  }
});

// An import that got no answer at all (a dropped socket, a timeout) may still
// have committed, so it reads as lost — never as a plain "cannot reach core"
// that invites a rerun. Preview/export keep `req`'s own text.
test("bundle calls: an import with no answer rejects with the lost-answer message", async () => {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        socket.end();
      },
    },
  });
  try {
    const client = new AgetorClient({ port: listener.port, token: "tok" });
    const err = await client.importBundle("{}").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(0);
    expect((err as ApiError).message).toContain("the import may have run");
    expect((err as ApiError).message).toContain("cannot reach core (POST /bundle/import)");
    const preview = await client.previewBundleImport("{}").then(
      () => null,
      (e: unknown) => e,
    );
    expect((preview as ApiError).status).toBe(0);
    expect((preview as ApiError).message).toContain("cannot reach core (POST /bundle/import/preview)");
  } finally {
    listener.stop(true);
  }
});

test("bundle calls: an HTTP error answer keeps the core's own message", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ error: "import failed — nothing was imported: boom" }, { status: 500 }),
  });
  try {
    const client = new AgetorClient({ port: server.port!, token: "tok" });
    const err = await client.importBundle("{}").then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).message).toBe("import failed — nothing was imported: boom");
  } finally {
    server.stop(true);
  }
});
