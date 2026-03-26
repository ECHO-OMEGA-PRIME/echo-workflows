-- Echo Workflows v1.0.0 — D1 Schema

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  plan TEXT DEFAULT 'starter',
  max_workflows INTEGER DEFAULT 5,
  max_runs_per_day INTEGER DEFAULT 100,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  trigger_type TEXT DEFAULT 'manual',
  trigger_config TEXT,
  status TEXT DEFAULT 'draft',
  is_active INTEGER DEFAULT 0,
  run_count INTEGER DEFAULT 0,
  last_run_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_wf_tenant ON workflows(tenant_id);
CREATE INDEX IF NOT EXISTS idx_wf_active ON workflows(tenant_id, is_active);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  step_order INTEGER NOT NULL,
  step_type TEXT DEFAULT 'action',
  name TEXT NOT NULL,
  config TEXT,
  condition_json TEXT,
  on_failure TEXT DEFAULT 'stop',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id)
);
CREATE INDEX IF NOT EXISTS idx_steps_wf ON workflow_steps(workflow_id);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  input_data TEXT,
  output_data TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id)
);
CREATE INDEX IF NOT EXISTS idx_runs_wf ON workflow_runs(workflow_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON workflow_runs(tenant_id, status);

CREATE TABLE IF NOT EXISTS step_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  output_data TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id),
  FOREIGN KEY (step_id) REFERENCES workflow_steps(id)
);
CREATE INDEX IF NOT EXISTS idx_stepruns_run ON step_runs(run_id);

CREATE TABLE IF NOT EXISTS workflow_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT DEFAULT 'general',
  steps_json TEXT DEFAULT '[]',
  is_global INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tmpl_tenant ON workflow_templates(tenant_id);
