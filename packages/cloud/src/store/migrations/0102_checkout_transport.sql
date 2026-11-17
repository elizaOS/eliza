CREATE TABLE cloud_checkout_customers (
  organization_id text PRIMARY KEY REFERENCES organizations (id),
  customer_id text UNIQUE NOT NULL,
  checkout_id text
);
