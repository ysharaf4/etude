CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_tokens (
  token TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  device_name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_codes (
  email TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_keys (
  account_id TEXT PRIMARY KEY,
  keys_json TEXT NOT NULL,
  etag INTEGER NOT NULL DEFAULT 1,
  server_vk TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_snapshot (
  account_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  parts_json TEXT NOT NULL,
  size INTEGER NOT NULL,
  etag INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_events (
  account_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  device_token TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, seq),
  UNIQUE (account_id, id)
);

CREATE INDEX IF NOT EXISTS idx_sync_events_seq ON sync_events(account_id, seq);

CREATE TABLE IF NOT EXISTS blob_meta (
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, name)
);
