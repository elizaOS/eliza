import os
import logging
import dotenv
import time
import signal
import requests
from datetime import datetime, timedelta, timezone

from alibabacloud_ecs20140526.client import Client as ECSClient
from alibabacloud_tea_openapi import models as open_api_models
from alibabacloud_ecs20140526 import models as ecs_models
from alibabacloud_tea_util.client import Client as UtilClient
from desktop_env.providers.base import VMManager
from desktop_env.providers.aliyun.config import ENABLE_TTL, DEFAULT_TTL_MINUTES


dotenv.load_dotenv()

for env_name in [
    "ALIYUN_REGION",
    "ALIYUN_VSWITCH_ID",
    "ALIYUN_SECURITY_GROUP_ID",
    "ALIYUN_IMAGE_ID",
    "ALIYUN_ACCESS_KEY_ID",
    "ALIYUN_ACCESS_KEY_SECRET",
    "ALIYUN_INSTANCE_TYPE",
]:
    if not os.getenv(env_name):
        raise EnvironmentError(f"{env_name} must be set in the environment variables.")


logger = logging.getLogger("desktopenv.providers.aliyun.AliyunVMManager")
logger.setLevel(logging.INFO)

ALIYUN_INSTANCE_TYPE = os.getenv("ALIYUN_INSTANCE_TYPE")
ALIYUN_ACCESS_KEY_ID = os.getenv("ALIYUN_ACCESS_KEY_ID")
ALIYUN_ACCESS_KEY_SECRET = os.getenv("ALIYUN_ACCESS_KEY_SECRET")
ALIYUN_REGION = os.getenv("ALIYUN_REGION")
ALIYUN_IMAGE_ID = os.getenv("ALIYUN_IMAGE_ID")
ALIYUN_SECURITY_GROUP_ID = os.getenv("ALIYUN_SECURITY_GROUP_ID")
ALIYUN_VSWITCH_ID = os.getenv("ALIYUN_VSWITCH_ID")
ALIYUN_RESOURCE_GROUP_ID = os.getenv("ALIYUN_RESOURCE_GROUP_ID")

WAIT_DELAY = 20
MAX_ATTEMPTS = 15


def _allocate_vm(screen_size=(1920, 1080)):
    """
    Allocate a new Aliyun ECS instance
    """
    assert screen_size == (1920, 1080), "Only 1920x1080 screen size is supported"

    config = open_api_models.Config(
        access_key_id=ALIYUN_ACCESS_KEY_ID,
        access_key_secret=ALIYUN_ACCESS_KEY_SECRET,
        region_id=ALIYUN_REGION,
    )
    client = ECSClient(config)
    instance_id = None
    original_sigint_handler = signal.getsignal(signal.SIGINT)
    original_sigterm_handler = signal.getsignal(signal.SIGTERM)

    def signal_handler(sig, frame):
        if instance_id:
            signal_name = "SIGINT" if sig == signal.SIGINT else "SIGTERM"
            logger.warning(
                f"Received {signal_name} signal, terminating instance {instance_id}..."
            )
            try:
                delete_request = ecs_models.DeleteInstancesRequest(
                    region_id=ALIYUN_REGION,
                    instance_ids=UtilClient.to_jsonstring([instance_id]),
                    force=True,
                )
                client.delete_instances(delete_request)
                logger.info(
                    f"Successfully terminated instance {instance_id} after {signal_name}."
                )
            except Exception as cleanup_error:
                logger.error(
                    f"Failed to terminate instance {instance_id} after {signal_name}: {str(cleanup_error)}"
                )

        # Restore original signal handlers
        signal.signal(signal.SIGINT, original_sigint_handler)
        signal.signal(signal.SIGTERM, original_sigterm_handler)

        # Raise appropriate exception based on signal type
        if sig == signal.SIGINT:
            raise KeyboardInterrupt
        else:
            # For SIGTERM, exit gracefully
            import sys

            sys.exit(0)

    try:
        # Set up signal handlers for both SIGINT and SIGTERM
        signal.signal(signal.SIGINT, signal_handler)
        signal.signal(signal.SIGTERM, signal_handler)

        logger.info(
            f"Creating new ECS instance in region {ALIYUN_REGION} with image {ALIYUN_IMAGE_ID}"
        )

        # TTL configuration
        ttl_enabled = ENABLE_TTL
        ttl_minutes = DEFAULT_TTL_MINUTES
        ttl_seconds = max(0, int(ttl_minutes) * 60)

        # Aliyun constraints: at least 30 minutes in the future, ISO8601 UTC, seconds must be 00
        now_utc = datetime.now(timezone.utc)
        min_eta = now_utc + timedelta(minutes=30)
        raw_eta = now_utc + timedelta(seconds=ttl_seconds)
        effective_eta = raw_eta if raw_eta > min_eta else min_eta
        # round up to the next full minute, zero seconds
        effective_eta = (effective_eta + timedelta(seconds=59)).replace(second=0, microsecond=0)
        auto_release_str = effective_eta.strftime('%Y-%m-%dT%H:%M:%SZ')
        logger.info(
            f"TTL config: enabled={ttl_enabled}, minutes={ttl_minutes}, seconds={ttl_seconds}, ETA(UTC)={auto_release_str}"
        )

        # Create instance request (attempt with auto_release_time first when TTL enabled)
        def _build_request(with_ttl: bool) -> ecs_models.RunInstancesRequest:
            kwargs = dict(
                region_id=ALIYUN_REGION,
                image_id=ALIYUN_IMAGE_ID,
                instance_type=ALIYUN_INSTANCE_TYPE,
                security_group_id=ALIYUN_SECURITY_GROUP_ID,
                v_switch_id=ALIYUN_VSWITCH_ID,
                instance_name=f"OSWorld-Desktop-{int(time.time())}",
                description="OSWorld Desktop Environment Instance",
                internet_max_bandwidth_out=10,
                internet_charge_type="PayByTraffic",
                instance_charge_type="PostPaid",
                system_disk=ecs_models.RunInstancesRequestSystemDisk(
                    size="50",
                    category="cloud_essd",
                ),
                deletion_protection=False,
            )
            
            if ALIYUN_RESOURCE_GROUP_ID:
                kwargs["resource_group_id"] = ALIYUN_RESOURCE_GROUP_ID
            
            if with_ttl and ttl_enabled and ttl_seconds > 0:
                kwargs["auto_release_time"] = auto_release_str
            return ecs_models.RunInstancesRequest(**kwargs)

        try:
            request = _build_request(with_ttl=True)
            response = client.run_instances(request)
        except Exception as create_err:
            # Retry without auto_release_time if creation-time TTL is rejected
            logger.warning(
                f"RunInstances with auto_release_time failed: {create_err}. Retrying without TTL field..."
            )
            request = _build_request(with_ttl=False)
            response = client.run_instances(request)
        instance_ids = response.body.instance_id_sets.instance_id_set

        if not instance_ids:
            raise RuntimeError(
                "Failed to create ECS instance - no instance ID returned"
            )

        instance_id = instance_ids[0]
        logger.info(f"ECS instance {instance_id} created successfully")

        # Wait for the instance to be running
        logger.info(f"Waiting for instance {instance_id} to be running...")
        _wait_for_instance_running(client, instance_id)

        logger.info(f"Instance {instance_id} is now running and ready")

    except KeyboardInterrupt:
        logger.warning("VM allocation interrupted by user (SIGINT).")
        if instance_id:
            logger.info(f"Terminating instance {instance_id} due to interruption.")
            try:
                delete_request = ecs_models.DeleteInstancesRequest(
                    region_id=ALIYUN_REGION,
                    instance_ids=UtilClient.to_jsonstring([instance_id]),
                    force=True,
                )
                client.delete_instances(delete_request)
            except Exception as cleanup_error:
                logger.error(
                    f"Failed to cleanup instance {instance_id}: {str(cleanup_error)}"
                )
        raise
    except Exception as e:
        logger.error(f"Failed to allocate ECS instance: {str(e)}")
        if instance_id:
            logger.info(f"Terminating instance {instance_id} due to an error.")
            try:
                delete_request = ecs_models.DeleteInstancesRequest(
                    region_id=ALIYUN_REGION,
                    instance_ids=UtilClient.to_jsonstring([instance_id]),
                    force=True,
                )
                client.delete_instances(delete_request)
            except Exception as cleanup_error:
                logger.error(
                    f"Failed to cleanup instance {instance_id}: {str(cleanup_error)}"
                )
        raise
    finally:
        # Restore original signal handlers
        signal.signal(signal.SIGINT, original_sigint_handler)
        signal.signal(signal.SIGTERM, original_sigterm_handler)

    return instance_id


def _wait_for_instance_running(
    client: ECSClient, instance_id: str, max_attempts: int = MAX_ATTEMPTS
):
    """Wait for instance to reach Running state"""
    for _ in range(max_attempts):
        try:
            req = ecs_models.DescribeInstancesRequest(
                region_id=ALIYUN_REGION,
                instance_ids=UtilClient.to_jsonstring([instance_id]),
            )
            response = client.describe_instances(req)

            if response.body.instances.instance:
                instance = response.body.instances.instance[0]
                status = instance.status
                logger.info(f"Instance {instance_id} status: {status}")

                if status == "Running":
                    return
                elif status in ["Stopped", "Stopping"]:
                    start_req = ecs_models.StartInstanceRequest(instance_id=instance_id)
                    client.start_instance(start_req)
                    logger.info(f"Started instance {instance_id}")

            time.sleep(WAIT_DELAY)

        except Exception as e:
            logger.warning(f"Error checking instance status: {e}")
            time.sleep(WAIT_DELAY)

    raise TimeoutError(
        f"Instance {instance_id} did not reach Running state within {max_attempts * WAIT_DELAY} seconds"
    )


def _wait_until_server_ready(public_ip: str):
    """Wait until the server is ready"""
    for _ in range(MAX_ATTEMPTS):
        try:
            logger.info(f"Checking server status on {public_ip}...")
            response = requests.get(f"http://{public_ip}:5000/", timeout=2)
            if response.status_code == 404:
                logger.info(f"Server {public_ip} is ready")
                return
        except Exception:
            time.sleep(WAIT_DELAY)

    raise TimeoutError(
        f"Server {public_ip} did not respond within {MAX_ATTEMPTS * WAIT_DELAY} seconds"
    )


class AliyunVMManager(VMManager):
    """
    Aliyun ECS VM Manager for managing virtual machines on Aliyun Cloud.

    Aliyun ECS does not need to maintain a registry of VMs, as it can dynamically allocate and deallocate VMs.
    """

    def __init__(self, **kwargs):
        self.initialize_registry()

    def initialize_registry(self, **kwargs):
        pass

    def add_vm(self, vm_path, lock_needed=True, **kwargs):
        pass

    def _add_vm(self, vm_path):
        pass

    def delete_vm(self, vm_path, lock_needed=True, **kwargs):
        pass

    def _delete_vm(self, vm_path):
        pass

    def occupy_vm(self, vm_path, pid, lock_needed=True, **kwargs):
        pass

    def _occupy_vm(self, vm_path, pid):
        pass

    def check_and_clean(self, lock_needed=True, **kwargs):
        pass

    def _check_and_clean(self):
        pass

    def list_free_vms(self, lock_needed=True, **kwargs):
        pass

    def _list_free_vms(self):
        pass

    def get_vm_path(self, screen_size=(1920, 1080), **kwargs):
        """Get a VM path (instance ID) for use"""
        logger.info(
            f"Allocating new ECS instance in region {ALIYUN_REGION} with screen size {screen_size}"
        )

        try:
            instance_id = _allocate_vm(screen_size)
            logger.info(f"Successfully allocated instance {instance_id}")
            return instance_id

        except Exception as e:
            logger.error(f"Failed to allocate instance: {str(e)}")
            raise
