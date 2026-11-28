ALTER TABLE usage_records
  ADD COLUMN sponsored_cost bigint CHECK (
    sponsored_cost IS NULL OR (
      service = 'inference' AND sponsored_cost >= 0
      AND charged = 0 AND from_allowance = 0 AND from_credits = 0 AND uncollected = 0
    )
  );
