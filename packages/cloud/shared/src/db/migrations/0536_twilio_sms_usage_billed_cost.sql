UPDATE "usage_records"
SET "input_cost" = "input_cost" + "markup"
WHERE "type" = 'twilio_sms'
  AND "markup" > 0
  AND CASE
    WHEN jsonb_typeof("metadata" -> 'billing' -> 'rawCost') = 'number'
      THEN "input_cost" = ("metadata" -> 'billing' ->> 'rawCost')::numeric
    ELSE FALSE
  END;
