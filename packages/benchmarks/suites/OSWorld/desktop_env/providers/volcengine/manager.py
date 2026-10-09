import os
import logging
import signal
import dotenv
import time
import volcenginesdkcore
import volcenginesdkecs.models as ecs_models
from volcenginesdkecs.api import ECSApi

from desktop_env.providers.base import VMManager

# Load environment variables from .env file
dotenv.load_dotenv()

for env_name in [
    "VOLCENGINE_ACCESS_KEY_ID",
    "VOLCENGINE_SECRET_ACCESS_KEY",
    "VOLCENGINE_REGION",
    "VOLCENGINE_SUBNET_ID",
    "VOLCENGINE_SECURITY_GROUP_ID",
    "VOLCENGINE_INSTANCE_TYPE",
    "VOLCENGINE_IMAGE_ID",
    "VOLCENGINE_ZONE_ID",
    "VOLCENGINE_DEFAULT_PASSWORD",
]:
    if not os.getenv(env_name):
        raise EnvironmentError(f"{env_name} must be set in the environment variables.")

logger = logging.getLogger("desktopenv.providers.volcengine.VolcengineVMManager")
logger.setLevel(logging.INFO)

VOLCENGINE_ACCESS_KEY_ID = os.getenv("VOLCENGINE_ACCESS_KEY_ID")
VOLCENGINE_SECRET_ACCESS_KEY = os.getenv("VOLCENGINE_SECRET_ACCESS_KEY")
VOLCENGINE_REGION = os.getenv("VOLCENGINE_REGION")
VOLCENGINE_SUBNET_ID = os.getenv("VOLCENGINE_SUBNET_ID")
VOLCENGINE_SECURITY_GROUP_ID = os.getenv("VOLCENGINE_SECURITY_GROUP_ID")
VOLCENGINE_INSTANCE_TYPE = os.getenv("VOLCENGINE_INSTANCE_TYPE")
VOLCENGINE_IMAGE_ID = os.getenv("VOLCENGINE_IMAGE_ID")
VOLCENGINE_ZONE_ID = os.getenv("VOLCENGINE_ZONE_ID")
VOLCENGINE_DEFAULT_PASSWORD = os.getenv("VOLCENGINE_DEFAULT_PASSWORD")

def _allocate_vm(screen_size=(1920, 1080)):
    """分配火山引擎虚拟机"""

    # 初始化火山引擎客户端
    configuration = volcenginesdkcore.Configuration()
    configuration.region = VOLCENGINE_REGION
    configuration.ak = VOLCENGINE_ACCESS_KEY_ID
    configuration.sk = VOLCENGINE_SECRET_ACCESS_KEY
    configuration.client_side_validation = True
    # set default configuration
    volcenginesdkcore.Configuration.set_default(configuration)

    # use global default configuration
    api_instance = ECSApi()
    
    instance_id = None
    original_sigint_handler = signal.getsignal(signal.SIGINT)
    original_sigterm_handler = signal.getsignal(signal.SIGTERM)
    
    def signal_handler(sig, frame):
        if instance_id:
            signal_name = "SIGINT" if sig == signal.SIGINT else "SIGTERM"
            logger.warning(f"Received {signal_name} signal, terminating instance {instance_id}...")
            try:
                api_instance.delete_instance(ecs_models.DeleteInstanceRequest(
                    instance_id=instance_id,
                ))
                logger.info(f"Successfully terminated instance {instance_id} after {signal_name}.")
            except Exception as cleanup_error:
                logger.error(f"Failed to terminate instance {instance_id} after {signal_name}: {str(cleanup_error)}")
        
        # Restore original signal handlers
        signal.signal(signal.SIGINT, original_sigint_handler)
        signal.signal(signal.SIGTERM, original_sigterm_handler)
        
        if sig == signal.SIGINT:
            raise KeyboardInterrupt
        else:
            import sys
            sys.exit(0)
    
    try:
        # Set up signal handlers
        signal.signal(signal.SIGINT, signal_handler)
        signal.signal(signal.SIGTERM, signal_handler)
        
        # 创建实例参数
        create_instance_params = ecs_models.RunInstancesRequest(
            image_id = VOLCENGINE_IMAGE_ID,
            instance_type = VOLCENGINE_INSTANCE_TYPE,
            network_interfaces=[ecs_models.NetworkInterfaceForRunInstancesInput(
                subnet_id=VOLCENGINE_SUBNET_ID,
                security_group_ids=[VOLCENGINE_SECURITY_GROUP_ID],
            )],
            eip_address=ecs_models.EipAddressForRunInstancesInput(
                bandwidth_mbps = 5,
                charge_type = "PayByTraffic",
            ),
            instance_name = f"osworld-{os.getpid()}-{int(time.time())}",
            volumes=[ecs_models.VolumeForRunInstancesInput(
                volume_type="ESSD_PL0",
                size=30,
            )],
            zone_id=VOLCENGINE_ZONE_ID,
            password = VOLCENGINE_DEFAULT_PASSWORD,  # 默认密码
            description = "OSWorld evaluation instance"
        )
        
        # 创建实例
        response = api_instance.run_instances(create_instance_params)
        instance_id = response.instance_ids[0]
        
        logger.info(f"Waiting for instance {instance_id} to be running...")
        
        # 等待实例运行
        while True:
            instance_info = api_instance.describe_instances(ecs_models.DescribeInstancesRequest(
                instance_ids=[instance_id]
            ))
            status = instance_info.instances[0].status
            if status == 'RUNNING':
                break
            elif status in ['STOPPED', 'ERROR']:
                raise Exception(f"Instance {instance_id} failed to start, status: {status}")
            time.sleep(5)
        
        logger.info(f"Instance {instance_id} is ready.")
        
        # 获取实例IP地址
        try:
            instance_info = api_instance.describe_instances(ecs_models.DescribeInstancesRequest(
                instance_ids=[instance_id]
            ))
            print(instance_info)
            public_ip = instance_info.instances[0].eip_address.ip_address
            private_ip = instance_info.instances[0].network_interfaces[0].primary_ip_address
            
            if public_ip:
                vnc_url = f"http://{public_ip}:5910/vnc.html"
                logger.info("="*80)
                logger.info(f"🖥️  VNC Web Access URL: {vnc_url}")
                logger.info(f"📡 Public IP: {public_ip}")
                logger.info(f"🏠 Private IP: {private_ip}")
                logger.info(f"🆔 Instance ID: {instance_id}")
                logger.info("="*80)
                print(f"\n🌐 VNC Web Access URL: {vnc_url}")
                print(f"📍 Please open the above address in the browser for remote desktop access\n")
        except Exception as e:
            logger.warning(f"Failed to get VNC address for instance {instance_id}: {e}")
            
    except KeyboardInterrupt:
        logger.warning("VM allocation interrupted by user (SIGINT).")
        if instance_id:
            logger.info(f"Terminating instance {instance_id} due to interruption.")
            api_instance.delete_instance(ecs_models.DeleteInstanceRequest(
                instance_id=instance_id,
            ))
        raise
    except Exception as e:
        logger.error(f"Failed to allocate VM: {e}", exc_info=True)
        if instance_id:
            logger.info(f"Terminating instance {instance_id} due to an error.")
            api_instance.delete_instance(ecs_models.DeleteInstanceRequest(
                instance_id=instance_id,
            ))
        raise
    finally:
        # Restore original signal handlers
        signal.signal(signal.SIGINT, original_sigint_handler)
        signal.signal(signal.SIGTERM, original_sigterm_handler)

    return instance_id


class VolcengineVMManager(VMManager):
    """
    Volcengine VM Manager for managing virtual machines on Volcengine.
    
    Volcengine does not need to maintain a registry of VMs, as it can dynamically allocate and deallocate VMs.
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
        logger.info("Allocating a new VM in region: {region}".format(region=VOLCENGINE_REGION))
        new_vm_path = _allocate_vm(screen_size=screen_size)
        return new_vm_path