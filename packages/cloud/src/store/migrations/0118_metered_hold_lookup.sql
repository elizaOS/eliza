CREATE INDEX holds_organization_request ON holds
  (organization_id, service, (state->'key'->>'requestId'))
  WHERE service IN ('inference', 'speech');
