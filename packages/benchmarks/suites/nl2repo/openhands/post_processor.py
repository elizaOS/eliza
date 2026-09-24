import os
import json
import zipfile
import shutil
import subprocess
import logging
import re
from datetime import datetime
from typing import List, Dict, Any
from test_data_service import TestData
from docker_self.docker_service import (
    DockerHostInfo,
    create_docker_client,
    list_images,
    pull_image,
    build_image,
    run_container,
    create_advanced_container,
    start_container,
    stop_container,
    remove_container,
    execute_command_in_container,
    get_container_logs
)


def log_to_both(original_logger, log_file_path: str, level: str, message: str):
    """
    Log a message to both the original logger and a log file.

    Args:
        original_logger: Logger object for logging
        log_file_path: Path to the log file
        level: Log level (info, warning, error, debug)
        message: Log message
    """
 
    if level == 'info':
        original_logger.info(message)
    elif level == 'warning':
        original_logger.warning(message)
    elif level == 'error':
        original_logger.error(message)
    elif level == 'debug':
        original_logger.debug(message)


    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    log_line = f"{timestamp} - {level.upper()} - {message}\n"

    try:
        with open(log_file_path, 'a', encoding='utf-8') as f:
            f.write(log_line)
    except Exception as e:
        # If writing to file fails, log the error via the original logger
        original_logger.error(f"Log to file failed: {str(e)}")


class DualLogger:
    """
    A logger that outputs to both the original logger and a log file.

    """

    def __init__(self, original_logger, log_file_path: str):
        self.original_logger = original_logger
        self.log_file_path = log_file_path

        # Make sure the directory exists
        os.makedirs(os.path.dirname(log_file_path), exist_ok=True)

        # Initialize 
        try:
            with open(log_file_path, 'w', encoding='utf-8') as f:
                f.write(f"=== Post Process Log Started at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ===\n")
        except Exception as e:
            original_logger.error(f"Initialize log file failed: {str(e)}")

    def info(self, message: str):
        log_to_both(self.original_logger, self.log_file_path, 'info', message)

    def warning(self, message: str):
        log_to_both(self.original_logger, self.log_file_path, 'warning', message)

    def error(self, message: str):
        log_to_both(self.original_logger, self.log_file_path, 'error', message)

    def debug(self, message: str):
        log_to_both(self.original_logger, self.log_file_path, 'debug', message)


def create_workspace_zip(workspace_path: str, logger) -> str:
    """
    Create a zip file of the workspace folder.

    Args:
        workspace_path: workspace path
        logger: logger

    Returns:
        zip path
    """
    logger.info(f"Start creating zip file: {workspace_path}")

    zip_path = workspace_path + ".zip"

    try:
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for root, dirs, files in os.walk(workspace_path):
                for file in files:
                    file_path = os.path.join(root, file)
                    arcname = os.path.relpath(file_path, workspace_path)
                    zipf.write(file_path, arcname)

        logger.info(f"Successfully created zip file: {zip_path}")
        return zip_path

    except Exception as e:
        logger.error(f"Failed to create zip file: {str(e)}")
        raise


def load_docker_image(tar_path: str, host_info: DockerHostInfo, logger) -> Dict[str, str]:
    """
    Load a tar image file and get the image name and tag.

    Args:
        tar_path: tar image file path
        host_info: Docker host information
        logger: logger

    Returns:
        A dict containing the image name and tag.
    """
    logger.info(f"Start loading Docker image: {tar_path}")

    try:
        client = create_docker_client(host_info)

        with open(tar_path, 'rb') as f:
            loaded_images = client.image.load(f.read())

        if loaded_images:
            logger.info(f"Loaded Images：{loaded_images}")

       
            if isinstance(loaded_images, list):
                image_name_str = loaded_images[0]
            else:
                image_name_str = loaded_images

            logger.info(f"Selected Image Name：{image_name_str}")

            try:
                image_obj = client.image.inspect(image_name_str)
                logger.info(f"Successfully inspected image, ID: {image_obj.id}")
            except Exception as e:
                logger.warning(f"Failed to inspect image: {str(e)}")
                image_obj = None

         
            if ':' in image_name_str:
                image_name, image_tag = image_name_str.split(':', 1)
            else:
                image_name, image_tag = image_name_str, 'latest'

            logger.info(f"Successfully loaded image: {image_name}:{image_tag}")

            result = {
                'image_name': image_name,
                'image_tag': image_tag,
                'full_tag': image_name_str,
                'image_id': image_obj.id if image_obj and hasattr(image_obj, 'id') else 'unknown'
            }

            logger.info(f"Image Load Result: {result}")
            return result
        else:
            logger.error("No image loaded successfully")
            raise ValueError("No image loaded successfully")

    except Exception as e:
        logger.error(f"Failed to load Docker image: {str(e)}")
        raise


def remove_package_files(workspace_path: str, logger):
    """
    Delete package management files in the workspace

    Args:
        workspace_path: workspace path
        logger: logger
    """
    logger.info("Start removing package files")

    package_files = [
        "setup.py",
        "pyproject.toml",
        "setup.cfg",
        "requirements.txt",
        "requirements-dev.txt",
        "requirements-test.txt",
        "tox.ini",
        "pytest.ini",
        "poetry.lock",
        "Pipfile",
        "Pipfile.lock",
        "environment.yml",
        "conda-env.yaml",
        "manifest.in",
        "MANIFEST.in"
    ]

    removed_files = []

    for root, dirs, files in os.walk(workspace_path):
        for file in files:
            if file in package_files:
                file_path = os.path.join(root, file)
                try:
                    os.remove(file_path)
                    removed_files.append(file_path)
                    logger.info(f"删除包管理文件: {file_path}")
                except Exception as e:
                    logger.warning(f"删除文件失败 {file_path}: {str(e)}")

    logger.info(f"共删除了 {len(removed_files)} 个包管理文件")


def remove_test_files(workspace_path: str, test_files: List[str], logger):
    """
    根据测试文件列表删除workspace中的同名文件或文件夹

    Args:
        workspace_path: workspace路径
        test_files: 测试文件列表
        logger: 日志记录器
    """
    logger.info(f"开始删除测试文件，共 {len(test_files)} 个文件/文件夹")

    removed_items = []

    for test_file in test_files:
        target_path = os.path.join(workspace_path, test_file)

        try:
            if os.path.exists(target_path):
                if os.path.isdir(target_path):
                    shutil.rmtree(target_path)
                    logger.info(f"Deleting directory: {target_path}")
                else:
                    os.remove(target_path)
                    logger.info(f"Deleting file: {target_path}")
                removed_items.append(target_path)
            else:
                logger.warning(f"File or directory does not exist: {target_path}")

        except Exception as e:
            logger.error(f"Failed to delete {target_path}: {str(e)}")

    logger.info(f"Successfully deleted {len(removed_items)} files/directories")


def create_dockerfile(workspace_path: str, base_image_tag: str, logger) -> str:
    """
    Create Dockerfile 

    Args:
        workspace_path: workspace path
        base_image_tag: base image tag
        logger: logger

    Returns:
        Dockerfile path
    """
    logger.info("Start creating Dockerfile")

    dockerfile_dir = os.path.dirname(workspace_path)
    dockerfile_path = os.path.join(dockerfile_dir, "Dockerfile")

    dockerfile_content = f"""FROM --platform=linux/amd64  ghcr.io/multimodal-art-projection/nl2repobench/{base_image_tag}

# Copy workspace content to container
COPY workspace /workspace

# Set working directory
WORKDIR /workspace

# Set environment variables
ENV PYTHONPATH=/workspace:$PYTHONPATH

# Keep container running
CMD ["tail", "-f", "/dev/null"]
"""

    try:
        with open(dockerfile_path, 'w', encoding='utf-8') as f:
            f.write(dockerfile_content)

        logger.info(f"Successfully created Dockerfile: {dockerfile_path}")
        return dockerfile_path

    except Exception as e:
        logger.error(f"Failed to create Dockerfile: {str(e)}")
        raise


def build_test_image(dockerfile_path: str, image_tag: str, host_info: DockerHostInfo, logger) -> str:
    """
    Construct test image

    Args:
        dockerfile_path: Dockerfile path
        image_tag: image tag
        host_info: Docker host info
        logger: logger

    Returns:
        image id
    """
    logger.info(f"Start building test image: {image_tag}")  

    try:
        build_context = os.path.dirname(dockerfile_path)

        image, build_logs = build_image(host_info, dockerfile_path, image_tag, build_context)

        # 记录构建日志
        for log_line in build_logs:
            logger.info(f"Build: {log_line}")

        logger.info(f"Successfully build image: {image_tag}, ID: {image.id}")
        return image.id

    except Exception as e:
        logger.error(f"Failed to build image: {str(e)}")
        raise


def run_test_commands(image_tag: str, container_name: str, test_commands: List[str], test_case_count: int,
                      host_info: DockerHostInfo, logger) -> Dict[str, Any]:
    """
    Run test commands in container

    Args:
        image_tag: image tag
        container_name: container name
        test_commands: test commands list
        test_case_count: test case count
        host_info: Docker host info
        logger: logger

    Returns:
        test results dict
    """
    logger.info(f"Start running test commands, total {len(test_commands)} commands")

    try:
        # 创建并启动容器
        container = create_advanced_container(
            host_info=host_info,
            image_name=image_tag,
            container_name=container_name,
            working_dir="/workspace",
            command=["tail", "-f", "/dev/null"]  # 保持容器运行
        )

        logger.info(f"Successfully create test container: {container_name}")

        command_results = []
        last_exit_code = 0

       
        for i, command in enumerate(test_commands):
            logger.info(f"Executing command {i + 1}/{len(test_commands)}: {command}")

            try:
                exit_code, output = execute_command_in_container(
                    host_info=host_info,
                    container_id=container_name,
                    command=command,
                    workdir="/workspace"
                )

                logger.info(f"Command executed successfully, exit code: {exit_code}")
                logger.info(f"Command output: {output}")

                command_results.append({
                    'command': command,
                    'exit_code': exit_code,
                    'output': output
                })

                last_exit_code = exit_code

            except Exception as e:
                logger.error(f"Command execution failed: {str(e)}")
                command_results.append({
                    'command': command,
                    'exit_code': -1,
                    'output': str(e)
                })
                last_exit_code = -1

        # Analyze pytest results
        pytest_results = analyze_pytest_results(command_results, test_case_count, logger)

        # Stop and remove container
        try:
            stop_container(host_info, container_name)
            remove_container(host_info, container_name)
            logger.info(f"Test container removed: {container_name}")
        except Exception as e:
            logger.warning(f"Failed to remove test container: {str(e)}")

        return {
            'command_results': command_results,
            'last_exit_code': last_exit_code,
            'pytest_results': pytest_results,
            'container_id': container.id
        }

    except Exception as e:
        logger.error(f"Failed to run test commands: {str(e)}")
        raise


def analyze_pytest_results(command_results: List[Dict], total_test_cases: int, logger) -> Dict[str, Any]:
    """
    Analyze pytest command results

    Args:
        command_results: Command execution results list
        total_test_cases: Total test case count 
        logger: Logger instance

    Returns:
        pytest analysis results
    """
    logger.info("Start analyzing pytest results")

    pytest_results = {
        'passed': 0,
        'failed': 0,
        'errors': 0,
        'total': total_test_cases,
        'success_rate': 0.0
    }

    for result in command_results:
        command = result['command']
        output = result['output']

        # 检查是否是pytest命令
        if 'pytest' in command.lower():
            logger.info(f"Analyzing pytest command: {command}")


            for line in output.split('\n'):
               
                passed_match = re.search(r'(\d+) passed', line)
                if passed_match:
                    pytest_results['passed'] += int(passed_match.group(1))

               
                failed_match = re.search(r'(\d+) failed', line)
                if failed_match:
                    pytest_results['failed'] += int(failed_match.group(1))

                
                error_match = re.search(r'(\d+) error', line)
                if error_match:
                    pytest_results['errors'] += int(error_match.group(1))

    # 计算成功率（使用testData提供的总数）
    if pytest_results['total'] > 0:
        pytest_results['success_rate'] = min(pytest_results['passed'] / pytest_results['total'],1)

    logger.info(f"pytest analysis results: {pytest_results}")
    logger.info(f"Using total test case count from testData: {total_test_cases}")
    return pytest_results


def post_process_task(task_uuid: str, workspace_path: str, test_data: TestData, original_logger,
                      docker_host: str = "localhost") -> Dict[str, Any]:
    """
    Post-process a task after its completion

    Args:
        task_uuid: UUID of the task
        workspace_path: Path to the workspace directory
        test_data: TestData object containing test information
        original_logger: Logger object for logging
        docker_host: Hostname of the Docker daemon, default is "localhost"

    Returns:
        A dictionary containing the post-processing results
    """

    log_file_path = os.path.join(os.path.dirname(workspace_path), "log.log")
    logger = DualLogger(original_logger, log_file_path)

    logger.info(f"开始执行任务后处理流程，任务UUID: {task_uuid}")


    host_info = DockerHostInfo(hostname=docker_host)

    try:
        
        zip_path = create_workspace_zip(workspace_path, logger)

        
        #image_info = load_docker_image(test_data.imageTar, host_info, logger)
        image_info = {"full_tag": test_data.proName + ":1.0"}

        
        remove_package_files(workspace_path, logger)

        
        remove_test_files(workspace_path, test_data.pyTestFileList, logger)

       
        dockerfile_path = create_dockerfile(workspace_path, image_info['full_tag'], logger)

        
        test_image_tag = f"python-test-{task_uuid}"
        image_id = build_test_image(dockerfile_path, test_image_tag, host_info, logger)

        container_name = f"python-test-{task_uuid}"
        test_results = run_test_commands(test_image_tag, container_name, test_data.testShell, test_data.testCaseCount,
                                         host_info, logger)

        logger.info("Post-Process task done")

        return {
            'status': 'success',
            'task_uuid': task_uuid,
            'zip_path': zip_path,
            'log_path': log_file_path,
            'image_info': image_info,
            'test_image_tag': test_image_tag,
            'test_image_id': image_id,
            'test_results': test_results,
            'pytest_results': test_results['pytest_results']
        }

    except Exception as e:
        logger.error(f"Post-Process task failed: {str(e)}")
        return {
            'status': 'error',
            'task_uuid': task_uuid,
            'error': str(e),
            'log_path': log_file_path
        }
