UPDATE "usage_records"
SET "input_cost" = "input_cost" + "markup"
WHERE "type" = 'twilio_sms'
  AND "markup" > 0
  AND "metadata" -> 'billing' ->> 'rawCost' IS NOT NULL
  AND "input_cost" = ("metadata" -> 'billing' ->> 'rawCost')::numeric;
