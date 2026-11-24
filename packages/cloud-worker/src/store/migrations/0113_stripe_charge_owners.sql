CREATE TABLE cloud_stripe_charge_owners (
  charge_id text PRIMARY KEY,
  customer_id text NOT NULL REFERENCES cloud_checkout_customers (customer_id) ON DELETE CASCADE
);

CREATE INDEX cloud_stripe_charge_owners_by_customer ON cloud_stripe_charge_owners (customer_id);
