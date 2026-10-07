import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { expect, test, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

interface TaskRow {
  id: string;
  title: string;
}

async function createTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
): Promise<TaskRow> {
  const response = await request.post(`${backend.apiBase}/tasks`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
    data: {
      title,
      prompt: "verify scheduled task controls",
      agent: "claude-code",
      isolation: "none",
      workdir: tmpdir(),
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return await response.json() as TaskRow;
}

function taskCard(page: Page, title: string) {
  return page.locator(".cursor-grab").filter({ has: page.getByText(title, { exact: true }) });
}

test.describe("scheduled task controls", () => {
  test("shows, reschedules, cancels, and runs a scheduled task from its details", async ({
    page,
    request,
    backend,
  }) => {
    const title = `schedule-e2e ${randomUUID()}`;
    const task = await createTask(request, backend, title);
    const auth = { authorization: `Bearer ${backend.apiToken}` };
    const firstRunAt = Date.now() + 15 * 60_000;
    const scheduled = await request.post(`${backend.apiBase}/tasks/${task.id}/schedule`, {
      headers: auth,
      data: { runAt: firstRunAt, timeZone: "UTC" },
    });
    expect(scheduled.ok(), await scheduled.text()).toBeTruthy();

    await gotoApp(page, backend.bootBase);
    const card = taskCard(page, title);
    await expect(card).toBeVisible();
    await expect(card.getByTestId("task-card-schedule")).toContainText("Scheduled");

    await card.getByText(title, { exact: true }).click();
    const controls = page.getByTestId("task-schedule-controls");
    await expect(controls).toBeVisible();
    await expect(controls.getByText("Scheduled for")).toBeVisible();

    const input = controls.getByTestId("task-schedule-datetime");
    await input.fill("2031-01-02T12:30");
    await controls.getByTestId("task-schedule-save").click();
    await expect(controls.getByText("Scheduled for")).toBeVisible();

    const rescheduled = await request.get(`${backend.apiBase}/tasks/${task.id}`, { headers: auth });
    expect((await rescheduled.json() as { schedule: { runAt: number } }).schedule.runAt).toBe(
      new Date(2031, 0, 2, 12, 30).getTime(),
    );

    await controls.getByTestId("task-schedule-cancel").click();
    await expect(card.getByTestId("task-card-schedule")).toHaveCount(0);

    const secondRunAt = Date.now() + 15 * 60_000;
    const again = await request.post(`${backend.apiBase}/tasks/${task.id}/schedule`, {
      headers: auth,
      data: { runAt: secondRunAt, timeZone: "UTC" },
    });
    expect(again.ok(), await again.text()).toBeTruthy();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(controls.getByTestId("task-schedule-run-now")).toBeEnabled();
    await controls.getByTestId("task-schedule-run-now").click();
    await expect.poll(async () => {
      const current = await request.get(`${backend.apiBase}/tasks/${task.id}`, { headers: auth });
      return (await current.json() as { column: string }).column;
    }).toBe("running");
  });
});
