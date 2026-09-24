CREATE TABLE billing_organization_subjects (
  id uuid PRIMARY KEY,
  live_organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_organization_subjects_identity CHECK(live_organization_id IS NULL OR live_organization_id=id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX billing_organization_subjects_live_idx ON billing_organization_subjects(live_organization_id);
--> statement-breakpoint
CREATE TABLE billing_app_subjects (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES billing_organization_subjects(id) ON DELETE RESTRICT,
  live_app_id uuid REFERENCES apps(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_app_subjects_owner_key UNIQUE(id,organization_id),
  CONSTRAINT billing_app_subjects_identity CHECK(live_app_id IS NULL OR live_app_id=id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX billing_app_subjects_live_idx ON billing_app_subjects(live_app_id);
--> statement-breakpoint
CREATE TABLE billing_registration_subjects (
  id uuid PRIMARY KEY,
  app_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  live_registration_id uuid REFERENCES app_client_registrations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_registration_subjects_id_app_key UNIQUE(id,app_id),
  CONSTRAINT billing_registration_subjects_app_owner_fk FOREIGN KEY(app_id,organization_id) REFERENCES billing_app_subjects(id,organization_id) ON DELETE RESTRICT,
  CONSTRAINT billing_registration_subjects_identity CHECK(live_registration_id IS NULL OR live_registration_id=id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX billing_registration_subjects_live_idx ON billing_registration_subjects(live_registration_id);
