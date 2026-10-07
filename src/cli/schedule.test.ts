import { afterAll, expect, mock, test } from "bun:test";
import { makeTask } from "./test-fixtures.ts";
import * as realContext from "./context.ts";
import * as realOutput from "./output.ts";

const context = { ...realContext };
const output = { ...realOutput };
const task = makeTask();
const calls: unknown[][] = [];
const printed: unknown[] = [];
mock.module("./context.ts", () => ({
  ...context,
  getClient: async () => ({
    listTasks: async () => [task],
    scheduleTask: async (...args: unknown[]) => { calls.push(args); return task; },
    cancelTaskSchedule: async (...args: unknown[]) => { calls.push(args); return task; },
  }),
}));
mock.module("./output.ts", () => ({
  ...output,
  out: (value: unknown) => printed.push(value),
  printJson: (value: unknown) => printed.push(value),
}));
afterAll(() => {
  mock.module("./context.ts", () => context);
  mock.module("./output.ts", () => output);
});
const { cmdSchedule, cmdUnschedule } = await import("./commands/manage.ts");
const flags = { json: true, plain: true, noDaemon: true };

test("schedule resolves task and sends UTC milliseconds plus display timezone", async () => {
  calls.length = printed.length = 0;
  await cmdSchedule([task.id, "2030-01-02T12:00:00+02:00", "--timezone", "Europe/Kiev"], flags);
  expect(calls).toEqual([[task.id, Date.parse("2030-01-02T10:00:00Z"), "Europe/Kiev"]]);
  expect(printed).toEqual([task]);
});

test("schedule rejects missing arguments, ambiguous dates, invalid zones and unknown options", async () => {
  for (const args of [
    [],
    [task.id],
    [task.id, "2030-01-02T12:00"],
    [task.id, "not-a-dateZ"],
    [task.id, "2030-02-30T12:00:00Z"],
    [task.id, "2030-01-02T24:00:00Z"],
    [task.id, "2030-01-02T12:60:00Z"],
    [task.id, "2030-01-02T12:00:00Z", "--timezone", "Mars/Olympus"],
    [task.id, "2030-01-02T12:00:00Z", "--unknown"],
  ]) {
    await expect(cmdSchedule(args, flags)).rejects.toThrow();
  }
});

test("unschedule resolves the task and returns the API result", async () => {
  calls.length = printed.length = 0;
  await cmdUnschedule([task.id], flags);
  expect(calls).toEqual([[task.id]]);
  expect(printed).toEqual([task]);
  await expect(cmdUnschedule([], flags)).rejects.toThrow();
});
