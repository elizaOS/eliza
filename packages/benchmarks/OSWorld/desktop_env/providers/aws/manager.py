import os
import boto3
import logging
import dotenv
import signal
from datetime import datetime, timedelta, timezone

# TTL configuration
from desktop_env.providers.aws.config import ENABLE_TTL, DEFAULT_TTL_MINUTES, AWS_SCHEDULER_ROLE_ARN
from desktop_env.providers.aws.scheduler_utils import schedule_instance_termination


INSTANCE_TYPE = "t3.xlarge" 

# Load environment variables from .env file
dotenv.load_dotenv()

# Ensure the AWS region is set in the environment
if not os.getenv('AWS_REGION'):
    raise EnvironmentError("AWS_REGION must be set in the environment variables.")

# Ensure the AWS subnet and security group IDs are set in the environment
if not os.getenv('AWS_SUBNET_ID') or not os.getenv('AWS_SECURITY_GROUP_ID'):
    raise EnvironmentError("AWS_SUBNET_ID and AWS_SECURITY_GROUP_ID must be set in the environment variables.")

from desktop_env.providers.base import VMManager

# Import proxy-related modules only when needed
try:
    from desktop_env.providers.aws.proxy_pool import get_global_proxy_pool, init_proxy_pool
    PROXY_SUPPORT_AVAILABLE = True
except ImportError:
    PROXY_SUPPORT_AVAILABLE = False

logger = logging.getLogger("desktopenv.providers.aws.AWSVMManager")
logger.setLevel(logging.INFO)

DEFAULT_REGION = "us-east-1"
# todo: Add doc for the configuration of image, security group and network interface
# todo: public the AMI images
IMAGE_ID_MAP = {
    "us-east-1": {
        (1920, 1080): "ami-0d23263edb96951d8",
        # For CoACT-1, uncomment to use the following AMI
        # (1920, 1080): "ami-0b505e9d0d99ba88c"
    },
    "ap-east-1": {
        (1920, 1080): "ami-06850864d18fad836"
        # Please transfer AMI by yourself from AWS us-east-1 for CoACT-1
    }
}


def _allocate_vm(region=DEFAULT_REGION, screen_size=(1920, 1080)):
    
    if region not in IMAGE_ID_MAP:
        raise ValueError(f"Region {region} is not supported. Supported regions are: {list(IMAGE_ID_MAP.keys())}")
    if screen_size not in IMAGE_ID_MAP[region]:
        raise ValueError(f"Screen size {screen_size} not supported for region {region}. Supported: {list(IMAGE_ID_MAP[region].keys())}")
    ami_id = IMAGE_ID_MAP[region][screen_size]

    ec2_client = boto3.client('ec2', region_name=region)
    instance_id = None
    original_sigint_handler = signal.getsignal(signal.SIGINT)
    original_sigterm_handler = signal.getsignal(signal.SIGTERM)
    
    def signal_handler(sig, frame):
        if instance_id:
            signal_name = "SIGINT" if sig == signal.SIGINT else "SIGTERM"
            logger.warning(f"Received {signal_name} signal, terminating instance {instance_id}...")
            try:
                ec2_client.terminate_instances(InstanceIds=[instance_id])
                logger.info(f"Successfully terminated instance {instance_id} after {signal_name}.")
            except Exception as cleanup_error:
                logger.error(f"Failed to terminate instance {instance_id} after {signal_name}: {str(cleanup_error)}")
        
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
        
        if not os.getenv('AWS_SECURITY_GROUP_ID'):
            raise ValueError("AWS_SECURITY_GROUP_ID is not set in the environment variables.")
        if not os.getenv('AWS_SUBNET_ID'):
            raise ValueError("AWS_SUBNET_ID is not set in the environment variables.")

        # TTL configuration (cloud-init removed; use cloud-side scheduler only)
        ttl_enabled = ENABLE_TTL
        ttl_minutes = DEFAULT_TTL_MINUTES
        ttl_seconds = max(0, int(ttl_minutes) * 60)
        eta_utc = datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)
        logger.info(f"TTL config: minutes={ttl_minutes}, seconds={ttl_seconds}, ETA(UTC)={eta_utc.isoformat()}")

        run_instances_params = {
            "MaxCount": 1,
            "MinCount": 1,
            "ImageId": ami_id,
            "InstanceType": INSTANCE_TYPE,
            "EbsOptimized": True,
            "InstanceInitiatedShutdownBehavior": "terminate",
            "NetworkInterfaces": [
                {
                    "SubnetId": os.getenv('AWS_SUBNET_ID'),
                    "AssociatePublicIpAddress": True,
                    "DeviceIndex": 0,
                    "Groups": [
                        os.getenv('AWS_SECURITY_GROUP_ID')
                    ]
                }
            ],
            "BlockDeviceMappings": [
                {
                    "DeviceName": "/dev/sda1", 
                    "Ebs": {
                        # "VolumeInitializationRate": 300
                        "VolumeSize": 30,  # Size in GB
                        "VolumeType": "gp3",  # General Purpose SSD
                        "Throughput": 1000,
                        "Iops": 4000  # Adjust IOPS as needed
                    }
                }
            ]
        }
        
        response = ec2_client.run_instances(**run_instances_params)
        instance_id = response['Instances'][0]['InstanceId']

        # Create TTL schedule immediately after instance is created, to survive early interruptions
        try:
            # Always attempt; helper resolves ARN via env or role name
            if ttl_enabled:
                schedule_instance_termination(region, instance_id, ttl_seconds, AWS_SCHEDULER_ROLE_ARN, logger)
        except Exception as e:
            logger.warning(f"Failed to create EventBridge Scheduler for {instance_id}: {e}")

        waiter = ec2_client.get_waiter('instance_running')
        logger.info(f"Waiting for instance {instance_id} to be running...")
        waiter.wait(InstanceIds=[instance_id])
        logger.info(f"Instance {instance_id} is ready.")

        try:
            instance_details = ec2_client.describe_instances(InstanceIds=[instance_id])
            instance = instance_details['Reservations'][0]['Instances'][0]
            public_ip = instance.get('PublicIpAddress', '')
            if public_ip:
                vnc_url = f"http://{public_ip}:5910/vnc.html"
                logger.info("="*80)
                logger.info(f"🖥️  VNC Web Access URL: {vnc_url}")
                logger.info(f"📡 Public IP: {public_ip}")
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
            ec2_client.terminate_instances(InstanceIds=[instance_id])
        raise
    except Exception as e:
        logger.error(f"Failed to allocate VM: {e}", exc_info=True)
        if instance_id:
            logger.info(f"Terminating instance {instance_id} due to an error.")
            ec2_client.terminate_instances(InstanceIds=[instance_id])
        raise
    finally:
        # Restore original signal handlers
        signal.signal(signal.SIGINT, original_sigint_handler)
        signal.signal(signal.SIGTERM, original_sigterm_handler)

    return instance_id


class AWSVMManager(VMManager):
    """
    AWS VM Manager for managing virtual machines on AWS.
    
    AWS does not need to maintain a registry of VMs, as it can dynamically allocate and deallocate VMs.
    This class supports both regular VM allocation and proxy-enabled VM allocation.
    """
    def __init__(self, **kwargs):
        # self.lock = FileLock(".aws_lck", timeout=60)
        self.initialize_registry()

    def initialize_registry(self, **kwargs):
        pass

    def add_vm(self, vm_path, region=DEFAULT_REGION, lock_needed=True, **kwargs):
        pass

    def _add_vm(self, vm_path, region=DEFAULT_REGION):
        pass

    def delete_vm(self, vm_path, region=DEFAULT_REGION, lock_needed=True, **kwargs):
        pass

    def _delete_vm(self, vm_path, region=DEFAULT_REGION):
        pass

    def occupy_vm(self, vm_path, pid, region=DEFAULT_REGION, lock_needed=True, **kwargs):
        pass

    def _occupy_vm(self, vm_path, pid, region=DEFAULT_REGION):
        pass

    def check_and_clean(self, lock_needed=True, **kwargs):
        pass

    def _check_and_clean(self):
        pass

    def list_free_vms(self, region=DEFAULT_REGION, lock_needed=True, **kwargs):
        pass

    def _list_free_vms(self, region=DEFAULT_REGION):
        pass

    def get_vm_path(self, region=DEFAULT_REGION, screen_size=(1920, 1080), **kwargs):
        logger.info("Allocating a new VM in region: {}".format(region))
        new_vm_path = _allocate_vm(region, screen_size=screen_size)
        return new_vm_path