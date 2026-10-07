CREATE TABLE task_schedules (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  run_at INTEGER NOT NULL,
  time_zone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'claimed', 'started', 'cancelled', 'failed', 'skipped')),
  revision TEXT NOT NULL,
  claim_id TEXT,
  run_id TEXT,
  error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_task_schedules_due ON task_schedules(status, run_at);
