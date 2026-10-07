import { randomUUID } from "node:crypto";
import { tasks } from "./db.ts";
import { startTask } from "./orchestrator.ts";
import { daemonLog } from "./daemon-log.ts";

const SCHEDULE_POLL_MS = 1_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let dispatching = false;

async function dispatchDueSchedules(): Promise<void> {
  if (dispatching) return;
  dispatching = true;
  try {
    const claimId = randomUUID();
    const due = tasks.schedule.claimDue(Date.now(), claimId);
    for (const item of due) {
      const task = tasks.get(item.taskId);
      if (
        !task
        || task.archivedAt != null
        || (task.column !== "backlog" && task.column !== "ready")
        || task.pipelineId != null
        || task.pipelineParentId != null
        || task.pendingInteractionCount > 0
        || task.fxRecovery?.autoResume
      ) {
        tasks.schedule.skip(item.taskId, claimId, "task is no longer eligible for a scheduled start");
        continue;
      }
      try {
        const result = await startTask(item.taskId, { scheduleClaimId: claimId });
        if ("error" in result) {
          daemonLog(`scheduled start ${item.taskId} failed: ${result.error}`);
        } else {
          daemonLog(`scheduled start ${item.taskId} began as run ${result.runId}`);
        }
      } catch (error) {
        const message = (error as Error)?.message ?? String(error);
        tasks.schedule.fail(item.taskId, claimId, message);
        daemonLog(`scheduled start ${item.taskId} failed: ${message}`);
      }
    }
  } catch (error) {
    daemonLog(`scheduled task dispatch failed: ${(error as Error)?.message ?? String(error)}`);
  } finally {
    dispatching = false;
  }
}

/** Re-arm interrupted claims only after this process has acquired the core API port. */
export function initTaskScheduler(): number {
  if (pollTimer) return 0;
  const rearmed = tasks.schedule.rearmClaimed();
  pollTimer = setInterval(() => {
    void dispatchDueSchedules();
  }, SCHEDULE_POLL_MS);
  pollTimer.unref();
  void dispatchDueSchedules();
  return rearmed;
}

export function stopTaskScheduler(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
