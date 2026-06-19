import os
import logging
from datetime import datetime

from alibabacloud_ecs20140526.client import Client as ECSClient
from alibabacloud_tea_openapi import models as open_api_models
from alibabacloud_ecs20140526 import models as ecs_models
from alibabacloud_tea_util.client import Client as UtilClient

from desktop_env.providers.base import Provider
from desktop_env.providers.aliyun.manager import (
    _allocate_vm,
    _wait_for_instance_running,
    _wait_until_server_ready,
)


logger = logging.getLogger("desktopenv.providers.aliyun.AliyunProvider")
logger.setLevel(logging.INFO)


class AliyunProvider(Provider):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.region = os.getenv("ALIYUN_REGION", "eu-central-1")
        self.client = self._create_client()
        # Whether to use private IP instead of public IP. Default: enabled.
        # Priority: explicit kwarg > env var ALIYUN_USE_PRIVATE_IP > default True
        env_use_private = os.getenv("ALIYUN_USE_PRIVATE_IP", "1").lower() in {"1", "true", "yes", "on"}
        kw_flag = kwargs.get("use_private_ip", None)
        self.use_private_ip = env_use_private if kw_flag is None else bool(kw_flag)

    def _create_client(self) -> ECSClient:
        config = open_api_models.Config(
            access_key_id=os.getenv("ALIYUN_ACCESS_KEY_ID"),
            access_key_secret=os.getenv("ALIYUN_ACCESS_KEY_SECRET"),
            region_id=self.region,
        )
        return ECSClient(config)

    def start_emulator(self, path_to_vm: str, headless: bool, *args, **kwargs):
        logger.info("Starting Aliyun ECS instance...")

        try:
            # Check the current state of the instance
            response = self._describe_instance(path_to_vm)
            if not response.body.instances.instance:
                logger.error(f"Instance {path_to_vm} not found")
                return

            instance = response.body.instances.instance[0]
            state = instance.status
            logger.info(f"Instance {path_to_vm} current state: {state}")

            if state == "Running":
                # If the instance is already running, skip starting it
                logger.info(
                    f"Instance {path_to_vm} is already running. Skipping start."
                )
                return

            if state == "Stopped":
                # Start the instance if it's currently stopped
                req = ecs_models.StartInstanceRequest(instance_id=path_to_vm)
                self.client.start_instance(req)
                logger.info(f"Instance {path_to_vm} is starting...")

                # Wait until the instance reaches 'Running' state
                _wait_for_instance_running(self.client, path_to_vm)
                logger.info(f"Instance {path_to_vm} is now running.")
            else:
                # For all other states (Pending, Starting, etc.), log a warning
                logger.warning(
                    f"Instance {path_to_vm} is in state '{state}' and cannot be started."
                )

        except Exception as e:
            logger.error(
                f"Failed to start the Aliyun ECS instance {path_to_vm}: {str(e)}"
            )
            raise

    def get_ip_address(self, path_to_vm: str) -> str:
        logger.info("Getting Aliyun ECS instance IP address...")

        try:
            response = self._describe_instance(path_to_vm)
            if not response.body.instances.instance:
                logger.error(f"Instance {path_to_vm} not found")
                return ""

            instance = response.body.instances.instance[0]

            # Get private and public IP addresses
            private_ip = ""
            public_ip = ""

            if hasattr(instance, "vpc_attributes") and instance.vpc_attributes:
                private_ip = (
                    instance.vpc_attributes.private_ip_address.ip_address[0]
                    if instance.vpc_attributes.private_ip_address.ip_address
                    else ""
                )

            if hasattr(instance, "public_ip_address") and instance.public_ip_address:
                public_ip = (
                    instance.public_ip_address.ip_address[0]
                    if instance.public_ip_address.ip_address
                    else ""
                )

            if hasattr(instance, "eip_address") and instance.eip_address:
                public_ip = instance.eip_address.ip_address or public_ip

            # Select which IP to use based on configuration
            ip_to_use = private_ip if (self.use_private_ip and private_ip) else public_ip

            if not ip_to_use:
                logger.warning("No usable IP address available (private/public both missing)")
                return ""

            _wait_until_server_ready(ip_to_use)
            if public_ip:
                vnc_url = f"http://{public_ip}:5910/vnc.html"
                logger.info(f"🖥️  VNC Web Access URL: {vnc_url}")
                logger.info("=" * 80)
            logger.info(f"📡 Public IP: {public_ip}")
            logger.info(f"🏠 Private IP: {private_ip}")
            logger.info(f"🔧 Using IP: {'Private' if ip_to_use == private_ip else 'Public'} -> {ip_to_use}")
            logger.info("=" * 80)
            print(f"\n🌐 VNC Web Access URL: {vnc_url}")
            print(
                "📍 Please open the above address in the browser "
                "for remote desktop access\n"
            )

            return ip_to_use

        except Exception as e:
            logger.error(
                f"Failed to retrieve IP address for the instance {path_to_vm}: {str(e)}"
            )
            raise

    def save_state(self, path_to_vm: str, snapshot_name: str):
        logger.info("Saving Aliyun ECS instance state...")

        try:
            req = ecs_models.CreateImageRequest(
                region_id=self.region,
                instance_id=path_to_vm,
                image_name=snapshot_name,
                description=f"Snapshot created at {datetime.now().isoformat()}",
            )
            response = self.client.create_image(req)
            image_id = response.body.image_id
            logger.info(
                f"Image {image_id} created successfully from instance {path_to_vm}."
            )
            return image_id

        except Exception as e:
            logger.error(
                f"Failed to create image from the instance {path_to_vm}: {str(e)}"
            )
            raise

    def revert_to_snapshot(self, path_to_vm: str, snapshot_name: str):
        logger.info(
            f"Reverting Aliyun ECS instance to snapshot image: {snapshot_name}..."
        )

        try:
            # Step 1: Retrieve the original instance details
            response = self._describe_instance(path_to_vm)
            if not response.body.instances.instance:
                logger.error(f"Instance {path_to_vm} not found")
                return
            # Step 2: Delete the old instance
            req = ecs_models.DeleteInstancesRequest(
                region_id=self.region, instance_id=[path_to_vm], force=True
            )
            self.client.delete_instances(req)
            logger.info(f"Old instance {path_to_vm} has been deleted.")

            # Step 3: Launch a new instance from the snapshot image
            new_instance_id = _allocate_vm()
            logger.info(f"Instance {new_instance_id} is ready.")

            # Get VNC access information
            self.get_ip_address(new_instance_id)

            return new_instance_id

        except Exception as e:
            logger.error(
                f"Failed to revert to snapshot {snapshot_name} for the instance {path_to_vm}: {str(e)}"
            )
            raise

    def stop_emulator(self, path_to_vm: str, region: str = None):
        logger.info(f"Stopping Aliyun ECS instance {path_to_vm}...")

        try:
            req = ecs_models.DeleteInstancesRequest(
                region_id=self.region, instance_id=[path_to_vm], force=True
            )
            self.client.delete_instances(req)
            logger.info(f"Instance {path_to_vm} has been deleted.")

        except Exception as e:
            logger.error(
                f"Failed to stop the Aliyun ECS instance {path_to_vm}: {str(e)}"
            )
            raise

    def _describe_instance(
        self, instance_id: str
    ) -> ecs_models.DescribeInstancesResponse:
        """Get instance details"""
        req = ecs_models.DescribeInstancesRequest(
            region_id=self.region, instance_ids=UtilClient.to_jsonstring([instance_id])
        )
        return self.client.describe_instances(req)
