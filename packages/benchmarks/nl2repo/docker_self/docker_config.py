
from .docker_service import DockerHostInfo
from logging_config import get_logger

logger = get_logger(__name__)


docker_host_list = []
# Add local environment to docker_host_list
docker_host_list.append(DockerHostInfo("localhost"))

# Add other environments to docker_host_list

# host_info = DockerHostInfo(hostname="127.0.0.1:2375", username="root", password="root")
# docker_host_list.append(host_info)

def get_local_host_info():
    return docker_host_list[0]


