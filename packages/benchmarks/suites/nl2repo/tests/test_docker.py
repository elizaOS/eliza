from logging_config import get_logger
from dataclasses import dataclass

from docker_self.docker_service import *

logger = get_logger(__name__)

@dataclass
class OpenhandsDockerEntry:
    """Openhands Docker Container Config"""
    docker_host_info: DockerHostInfo
    container_name: str
    port: str = "3000"
    path: str = "/.openhands-state"


def create_openhands_container(auto_entry: OpenhandsDockerEntry) -> str:
    """Create Openhands Advanced Container

    Args:
        auto_entry: Openhands Docker configuration 

    Returns:
        Container ID
    """
    # Set environment variables
    env_vars = {
        "SANDBOX_RUNTIME_CONTAINER_IMAGE": "docker.all-hands.dev/all-hands-ai/runtime:0.49-nikolaik",
        "LOG_ALL_EVENTS": "true"
    }

    # Set port mappings - format: {'container_port': host_port}
    ports = {auto_entry.port: int(auto_entry.port)}


    volumes = [
        ("/var/run/docker.sock", "/var/run/docker.sock", "rw"),
        (os.path.expanduser("~") + auto_entry.path, "/.openhands-state", "rw")
    ]

 
    extra_hosts = {"host.docker.internal": "host-gateway"}

    # Create and start the container
    container = create_advanced_container(
        host_info=auto_entry.docker_host_info,
        image_name="docker.all-hands.dev/all-hands-ai/openhands:0.49",  # Image name
        container_name=auto_entry.container_name,                       # Container name
        env_vars=env_vars,                                              # Environment variables
        ports=ports,                                                    # Port mappings
        volumes=volumes,                                                # Volume mounts
        command=None,                                                   # Commands (use default)
        auto_remove=True,                                               # (--rm)
        extra_hosts=extra_hosts,                                        # Extra host mappings
        pull_always=False                                               # Always pull image (--pull=always)
    )

    
    return container.id


if __name__ == '__main__':
    # Create Docker host info
    host_info = DockerHostInfo(hostname='localhost',tls_verify=False)

    
    pull_image(host_info, 'nginx:latest')

    # Run the container
    container_id = run_container(
        host_info,
        'nginx:latest',
        'my-nginx',
        ports={'80/tcp': 8080}
    )

    # List all containers
    containers = list_containers(host_info, all_containers=True)
    logger.info(containers)

    # Stop and remove the container
    stop_container(host_info, container_id.id)
    remove_container(host_info, container_id.id, force=True)

    images = list_images(host_info)
    print(images)

    tag_image(host_info, source_image='nginx:latest', target_image='my-nginx', tag='latest')
    remove_image(host_info, 'my-nginx:latest')

    containers = list_containers(host_info, all_containers=True)
    for container in containers:
        if 'runtime' in container.name:
            stop_container(host_info, container.id)
            remove_container(host_info, container.id, force=True)

    # Create Openhands container using the new wrapper function
    openhands_config = OpenhandsDockerEntry(
        docker_host_info=host_info,
        container_name="openhands-app-0",
        port="3000",
        path="/.openhands-state"
    )

    container_id = create_openhands_container(openhands_config)
