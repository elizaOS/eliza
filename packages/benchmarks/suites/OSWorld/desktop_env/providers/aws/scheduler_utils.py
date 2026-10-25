import os
import time
import json
from datetime import datetime, timedelta, timezone
import boto3
from botocore.exceptions import ClientError


def _resolve_scheduler_role_arn(logger) -> str:
    # 1) Explicit env takes precedence
    role_arn = os.getenv('AWS_SCHEDULER_ROLE_ARN', '').strip()
    if role_arn:
        return role_arn

    # 2) Derive from role name + account id
    role_name = os.getenv('AWS_SCHEDULER_ROLE_NAME', 'osworld-scheduler-ec2-terminate').strip()
    try:
        sts = boto3.client('sts')
        account_id = sts.get_caller_identity()['Account']
        derived_arn = f"arn:aws:iam::{account_id}:role/{role_name}"
        iam = boto3.client('iam')
        try:
            role = iam.get_role(RoleName=role_name)["Role"]
        except ClientError:
            auto_create = os.getenv('AWS_AUTO_CREATE_SCHEDULER_ROLE', 'true').lower() == 'true'
            if not auto_create:
                logger.warning(f"Scheduler role '{role_name}' not found and auto-create disabled.")
                return ''
            try:
                trust_policy = {
                    "Version": "2012-10-17",
                    "Statement": [
                        {
                            "Effect": "Allow",
                            "Principal": {"Service": "scheduler.amazonaws.com"},
                            "Action": "sts:AssumeRole"
                        }
                    ]
                }
                iam.create_role(RoleName=role_name, AssumeRolePolicyDocument=json.dumps(trust_policy))
                role = iam.get_role(RoleName=role_name)["Role"]
            except ClientError as ce:
                # If another process created it, fetch again
                try:
                    role = iam.get_role(RoleName=role_name)["Role"]
                except ClientError:
                    logger.warning(f"Failed to auto-create scheduler role '{role_name}': {ce}")
                    return ''

        # Ensure trust policy allows scheduler.amazonaws.com
        assume_doc = role.get("AssumeRolePolicyDocument", {})
        principal_ok = False
        try:
            for stmt in assume_doc.get("Statement", []):
                principal = stmt.get("Principal", {})
                svc = principal.get("Service")
                if isinstance(svc, str) and svc == "scheduler.amazonaws.com":
                    principal_ok = True
                    break
                if isinstance(svc, list) and "scheduler.amazonaws.com" in svc:
                    principal_ok = True
                    break
        except Exception:
            principal_ok = False
        if not principal_ok:
            trust_policy = {
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Effect": "Allow",
                        "Principal": {"Service": "scheduler.amazonaws.com"},
                        "Action": "sts:AssumeRole"
                    }
                ]
            }
            iam.update_assume_role_policy(RoleName=role_name, PolicyDocument=json.dumps(trust_policy))

        # Ensure minimal inline policy exists
        inline_name = f"{role_name}-inline"
        need_policy = False
        try:
            iam.get_role_policy(RoleName=role_name, PolicyName=inline_name)
        except ClientError:
            need_policy = True
        if need_policy:
            inline_policy = {
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Effect": "Allow",
                        "Action": ["ec2:TerminateInstances", "ec2:DescribeInstances"],
                        "Resource": "*"
                    }
                ]
            }
            iam.put_role_policy(RoleName=role_name, PolicyName=inline_name, PolicyDocument=json.dumps(inline_policy))

        # Wait for IAM propagation
        time.sleep(8)
        logger.info(f"Derived AWS_SCHEDULER_ROLE_ARN={derived_arn} from role name '{role_name}'")
        return derived_arn
    except Exception as e:
        logger.warning(f"Failed to resolve Scheduler Role ARN: {e}")
        return ''


def schedule_instance_termination(region: str, instance_id: str, ttl_seconds: int, role_arn: str, logger) -> None:
    if not role_arn:
        role_arn = _resolve_scheduler_role_arn(logger)
        if not role_arn:
            logger.info("Scheduler role ARN not available; skipping TTL schedule creation.")
            return
    scheduler_client = boto3.client('scheduler', region_name=region)
    schedule_name = f"osworld-ttl-{instance_id}-{int(time.time())}"
    eta_scheduler = datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)
    schedule_expression = f"at({eta_scheduler.strftime('%Y-%m-%dT%H:%M:%S')})"
    target_arn = "arn:aws:scheduler:::aws-sdk:ec2:terminateInstances"
    input_payload = '{"InstanceIds":["' + instance_id + '"]}'

    # Retry to tolerate IAM eventual consistency
    last_err = None
    for attempt in range(1, 7):  # ~ up to ~60s
        try:
            scheduler_client.create_schedule(
                Name=schedule_name,
                ScheduleExpression=schedule_expression,
                FlexibleTimeWindow={"Mode": "OFF"},
                ActionAfterCompletion='DELETE',
                Target={
                    "Arn": target_arn,
                    "RoleArn": role_arn,
                    "Input": input_payload
                },
                State='ENABLED',
                Description=f"OSWorld TTL terminate for {instance_id}"
            )
            logger.info(f"Scheduled EC2 termination via EventBridge Scheduler: name={schedule_name}, when={eta_scheduler.isoformat()} (UTC)")
            last_err = None
            break
        except ClientError as e:
            last_err = e
            code = e.response.get('Error', {}).get('Code')
            msg = e.response.get('Error', {}).get('Message', '')
            if code == 'ValidationException' and 'must allow AWS EventBridge Scheduler to assume the role' in msg:
                time.sleep(10)
                continue
            else:
                raise
    if last_err is not None:
        # If we exhausted retries, re-raise to surface warning upstream
        raise last_err


