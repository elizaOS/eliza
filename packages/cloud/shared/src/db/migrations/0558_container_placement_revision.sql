-- Physical placement changes are lifecycle changes even when status remains
-- deploying. Keep billing/retirement bookkeeping metadata outside this scope.
CREATE OR REPLACE FUNCTION advance_container_lifecycle_revision() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.status, NEW.image_tag, NEW.environment_vars, NEW.desired_count, NEW.cpu,
         NEW.memory, NEW.node_id, NEW.volume_path,
         NEW.metadata->'provider', NEW.metadata->'nodeId', NEW.metadata->'hostname',
         NEW.metadata->'containerName', NEW.metadata->'hostPort', NEW.metadata->'image',
         NEW.metadata->'imageDigest', NEW.metadata->'containerPort',
         NEW.metadata->'volumePath', NEW.metadata->'volumeMountPath')
     IS DISTINCT FROM
     ROW(OLD.status, OLD.image_tag, OLD.environment_vars, OLD.desired_count, OLD.cpu,
         OLD.memory, OLD.node_id, OLD.volume_path,
         OLD.metadata->'provider', OLD.metadata->'nodeId', OLD.metadata->'hostname',
         OLD.metadata->'containerName', OLD.metadata->'hostPort', OLD.metadata->'image',
         OLD.metadata->'imageDigest', OLD.metadata->'containerPort',
         OLD.metadata->'volumePath', OLD.metadata->'volumeMountPath') THEN
    NEW.lifecycle_revision := OLD.lifecycle_revision + 1;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
