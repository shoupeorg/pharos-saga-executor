CREATE TABLE IF NOT EXISTS sagas (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  state TEXT NOT NULL,
  owner TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  record_json TEXT NOT NULL,
  executing INTEGER NOT NULL DEFAULT 0,
  lock_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS saga_logs (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  saga_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  state TEXT NOT NULL,
  event TEXT NOT NULL,
  details_json TEXT NOT NULL,
  FOREIGN KEY (saga_id) REFERENCES sagas(id)
);

CREATE TABLE IF NOT EXISTS rate_limits (
  actor TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sagas_updated ON sagas(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_saga ON saga_logs(saga_id, sequence);

