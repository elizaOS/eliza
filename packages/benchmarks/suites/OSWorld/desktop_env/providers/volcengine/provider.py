import os
import time
import logging
import volcenginesdkcore
import volcenginesdkautoscaling
import volcenginesdkecs.models as ecs_models
from volcenginesdkcore.rest import ApiException
from volcenginesdkecs.api import ECSApi

from desktop_env.providers.base import Provider
from desktop_env.providers.volcengine.manager import _allocate_vm

logger = logging.getLogger("desktopenv.providers.volcengine.VolcengineProvider")
logger.setLevel(logging.INFO)

WAIT_DELAY = 15
MAX_ATTEMPTS = 10


class VolcengineProvider(Provider):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.region = os.getenv("VOLCENGINE_REGION", "eu-central-1")
        self.client = self._create_client()

    def _create_client(self) -> ECSApi:
        configuration = volcenginesdkcore.Configuration()
        configuration.ak = os.getenv('VOLCENGINE_ACCESS_KEY_ID')
        configuration.sk = os.getenv('VOLCENGINE_SECRET_ACCESS_KEY')
        configuration.region = os.getenv('VOLCENGINE_REGION')
        configuration.client_side_validation = True
        # set default configuration
        volcenginesdkcore.Configuration.set_default(configuration)
        return ECSApi()

    def start_emulator(self, path_to_vm: str, headless: bool, *args, **kwargs):
        logger.info("Starting Volcengine VM...")

        try:
            # 检查实例状态
            instance_info = self.client.describe_instances(ecs_models.DescribeInstancesRequest(
                instance_ids=[path_to_vm]
            ))
            status = instance_info.instances[0].status
            logger.info(f"Instance {path_to_vm} current status: {status}")

            if status == 'RUNNING':
                logger.info(f"Instance {path_to_vm} is already running. Skipping start.")
                return

            if status == 'STOPPED':
                # 启动实例
                self.client.start_instance(ecs_models.StartInstancesRequest(instance_ids=[path_to_vm]))
                logger.info(f"Instance {path_to_vm} is starting...")

                # 等待实例运行
                for attempt in range(MAX_ATTEMPTS):
                    time.sleep(WAIT_DELAY)
                    instance_info = self.client.describe_instances(ecs_models.DescribeInstancesRequest(
                        instance_ids=[path_to_vm]
                    ))
                    status = instance_info.instances[0].status

                    if status == 'RUNNING':
                        logger.info(f"Instance {path_to_vm} is now running.")
                        break
                    elif status == 'ERROR':
                        raise Exception(f"Instance {path_to_vm} failed to start")
                    elif attempt == MAX_ATTEMPTS - 1:
                        raise Exception(f"Instance {path_to_vm} failed to start within timeout")
            else:
                logger.warning(f"Instance {path_to_vm} is in status '{status}' and cannot be started.")

        except ApiException as e:
            logger.error(f"Failed to start the Volcengine VM {path_to_vm}: {str(e)}")
            raise

    def get_ip_address(self, path_to_vm: str) -> str:
        logger.info("Getting Volcengine VM IP address...")

        try:
            instance_info = self.client.describe_instances(ecs_models.DescribeInstancesRequest(
                instance_ids=[path_to_vm]
            ))

            public_ip = instance_info.instances[0].eip_address.ip_address
            private_ip = instance_info.instances[0].network_interfaces[0].primary_ip_address

            if public_ip:
                vnc_url = f"http://{public_ip}:5910/vnc.html"
                logger.info("=" * 80)
                logger.info(f"🖥️  VNC Web Access URL: {vnc_url}")
                logger.info(f"📡 Public IP: {public_ip}")
                logger.info(f"🏠 Private IP: {private_ip}")
                logger.info("=" * 80)
                print(f"\n🌐 VNC Web Access URL: {vnc_url}")
                print(f"📍 Please open the above address in the browser for remote desktop access\n")
            else:
                logger.warning("No public IP address available for VNC access")

            return private_ip

        except ApiException as e:
            logger.error(f"Failed to retrieve IP address for the instance {path_to_vm}: {str(e)}")
            raise

    def save_state(self, path_to_vm: str, snapshot_name: str):
        logger.info("Saving Volcengine VM state...")

        try:
            # 创建镜像
            response = self.client.create_image(ecs_models.CreateImageRequest(
                snapshot_id=snapshot_name,
                instance_id=path_to_vm,
                description=f"OSWorld snapshot: {snapshot_name}"
            ))
            image_id = response['image_id']
            logger.info(f"Image {image_id} created successfully from instance {path_to_vm}.")
            return image_id
        except ApiException as e:
            logger.error(f"Failed to create image from the instance {path_to_vm}: {str(e)}")
            raise

    def revert_to_snapshot(self, path_to_vm: str, snapshot_name: str):
        logger.info(f"Reverting Volcengine VM to snapshot: {snapshot_name}...")

        try:
            # 删除原实例
            self.client.delete_instance(ecs_models.DeleteInstanceRequest(
                instance_id=path_to_vm,
            ))
            logger.info(f"Old instance {path_to_vm} has been deleted.")

            # 创建实例
            new_instance_id = _allocate_vm()

            logger.info(f"New instance {new_instance_id} launched from image {snapshot_name}.")
            logger.info(f"Waiting for instance {new_instance_id} to be running...")

            # 等待新实例运行
            while True:
                instance_info = self.client.describe_instances(ecs_models.DescribeInstancesRequest(
                    instance_ids=[new_instance_id]
                ))
                status = instance_info.instances[0].status
                if status == 'RUNNING':
                    break
                elif status in ['STOPPED', 'ERROR']:
                    raise Exception(f"New instance {new_instance_id} failed to start, status: {status}")
                time.sleep(5)

            logger.info(f"Instance {new_instance_id} is ready.")

            # 获取新实例的IP地址
            try:
                instance_info = self.client.describe_instances(ecs_models.DescribeInstancesRequest(
                    instance_ids=[new_instance_id]
                ))
                public_ip = instance_info.instances[0].eip_address.ip_address
                if public_ip:
                    vnc_url = f"http://{public_ip}:5910/vnc.html"
                    logger.info("=" * 80)
                    logger.info(f"🖥️  New Instance VNC Web Access URL: {vnc_url}")
                    logger.info(f"📡 Public IP: {public_ip}")
                    logger.info(f"🆔 New Instance ID: {new_instance_id}")
                    logger.info("=" * 80)
                    print(f"\n🌐 New Instance VNC Web Access URL: {vnc_url}")
                    print(f"📍 Please open the above address in the browser for remote desktop access\n")
            except Exception as e:
                logger.warning(f"Failed to get VNC address for new instance {new_instance_id}: {e}")

            return new_instance_id

        except ApiException as e:
            logger.error(f"Failed to revert to snapshot {snapshot_name} for the instance {path_to_vm}: {str(e)}")
            raise

    def stop_emulator(self, path_to_vm, region=None):
        logger.info(f"Stopping Volcengine VM {path_to_vm}...")

        try:
            self.client.delete_instance(ecs_models.DeleteInstanceRequest(
                instance_id=path_to_vm,
            ))
            logger.info(f"Instance {path_to_vm} has been terminated.")
        except ApiException as e:
            logger.error(f"Failed to stop the Volcengine VM {path_to_vm}: {str(e)}")
            raise
