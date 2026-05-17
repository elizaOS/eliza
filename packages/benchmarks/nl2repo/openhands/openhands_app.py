import concurrent.futures
import json
import time
import uuid
import shutil
from docker_self.docker_service import *

from logging_config import get_logger
from test_data_service import test_data_list
from .post_processor import post_process_task
from docker_self.docker_config import get_local_host_info

logger = get_logger(__name__)



# Single App Data Object
class AppData:
    def __init__(self, module_name: str, base_url: str, sk: str, port: int, bo_size: int = 1):
        # 创建时需要初始化的属性
        self.module_name = module_name
        self.base_url = base_url
        self.sk = sk  
        self.port = port
        self.pro_name_list: List = []
        self.host_info = get_local_host_info()
        self.container = None

        
        self.session_id_list: List = []  # Session ID List
        self.last_status: bool = False  # Last Status, Default False
        self.bo_size = bo_size

    def get_base_url(self):
        return "http://127.0.0.1:" + self.port.__str__()

    def __repr__(self) -> str:
        """Provide string representation of the class, useful for debugging"""
        return (f"CustomClass(module_name={self.module_name!r}, base_url={self.base_url!r}, "
                f"sk={'***' if self.sk else None!r}, pro_name_list={self.pro_name_list!r}, "
                f"session_id_list={self.session_id_list!r}, last_status={self.last_status!r})")


def create_openhands_container(auto_entry: AppData) -> str:
    """Create Openhands Advanced Container

    Args:
        auto_entry: Openhands Docker Container Config

    Returns:
        Container ID
    """
    # Set environment variables
    env_vars = {
        "SANDBOX_RUNTIME_CONTAINER_IMAGE": "docker.all-hands.dev/all-hands-ai/runtime:0.49-nikolaik",
        "LOG_ALL_EVENTS": "true"
    }

    # Set port, default 3000
    ports = {'3000': auto_entry.port}


    # Set volume mounts, default path: ~/.openhands-state-{port}
    volumes = [
        ("/var/run/docker.sock", "/var/run/docker.sock", "rw"),
        (os.path.expanduser("~") + "/.openhands-state-" + auto_entry.port.__str__(), "/.openhands-state", "rw")
    ]

    # Set extra hosts, default: {"host.docker.internal": "host-gateway"}
    extra_hosts = {"host.docker.internal": "host-gateway"}

    container_name = "openhands-app-" + auto_entry.port.__str__()

    # Create container
    container = create_advanced_container(
        host_info=auto_entry.host_info,
        image_name="docker.all-hands.dev/all-hands-ai/openhands:0.49",  
        container_name=container_name,  # Container name
        env_vars=env_vars,  # Environment variables
        ports=ports,  # Port mappings
        volumes=volumes,  # Volume mounts
        command=None,  # Commands (use default)
        auto_remove=True,  # Auto remove(--rm)
        extra_hosts=extra_hosts,  # Extra host mappings
        pull_always=False  # Always pull image (--pull=always)
    )

    logger.info(f"容器ID: {container.id}")
    return container.id


# Single App Task Start
def start_app(app_data: AppData):
    # Headless mode
    
    if not app_data.pro_name_list:
        logger.error("pro name list is empty")
        return None

    task_uuid = app_data.pro_name_list[0] + "_bo" + str(app_data.bo_size)
    logger.info(f"Task UUID: {task_uuid}")


    workspaces_base_path = "workspaces"
    task_workspace_path = os.path.join(workspaces_base_path, task_uuid)
    workspace_path = os.path.join(task_workspace_path, "workspace")

    # Ensure workspace exists
    os.makedirs(workspace_path, exist_ok=True)
    logger.info(f"Create workspace directory: {workspace_path}")

    pro_name = app_data.pro_name_list[0]
    test_data = None
    logger.info(f"Full test data list: {test_data_list}")
    for data in test_data_list:
        if data.proName == pro_name:
            test_data = data
            break

    if not test_data:
        logger.error(f"Test data not found for project name: {pro_name}")
        return None

    logger.info(f"Found test data: {test_data.proName}")

    # Copy TestData.md to workspaces/{UUID}/workspace folder
    if test_data.md and os.path.exists(test_data.md):
        md_filename = os.path.basename(test_data.md)
        dest_md_path = os.path.join(workspace_path, md_filename)
        shutil.copy2(test_data.md, dest_md_path)
        logger.info(f"Copy md file from {test_data.md} to {dest_md_path}")
    else:
        logger.warning(f"Test data md file not exists or empty: {test_data.md}")

    # Copy config.template.toml to workspaces/{UUID} folder
    template_config_path = "./template/config.template.toml"
    module_name_replace = app_data.module_name.replace("/", "_")
    if os.path.exists(template_config_path):
        dest_config_path = os.path.join(task_workspace_path, "config.toml")
        shutil.copy2(template_config_path, dest_config_path)
        logger.info(f"Copy config template from {template_config_path} to {dest_config_path}")

        # Replace {{VOLUMES}} placeholder in config.toml with volumes value
        workspace_full_path = os.path.abspath(workspace_path)
        volumes_value = f'volumes = "{workspace_full_path}:/workspace:rw"'

        # Read config.toml content
        with open(dest_config_path, 'r', encoding='utf-8') as f:
            content = f.read()

        # Replace {{VOLUMES}} placeholder in config.toml with volumes value
        updated_content = content.replace('{{VOLUMES}}', volumes_value)
        model_definition = f"""
[llm.{module_name_replace}]
model = "{app_data.module_name}"
api_key = "{app_data.sk}"
                """
        if app_data.base_url:
            model_definition = model_definition +f"""\nbase_url ="{app_data.base_url}" """
        updated_content = updated_content.replace('{{MODULE_CONFIG}}', model_definition)

        # 写回文件
        with open(dest_config_path, 'w', encoding='utf-8') as f:
            f.write(updated_content)

        logger.info(f"Replace {{VOLUMES}} placeholder in config.toml with: {volumes_value}")
    else:
        logger.error(f"Config template file not exists: {template_config_path}")
        return None

    # 设置环境变量
    env_vars = {
        "SANDBOX_RUNTIME_CONTAINER_IMAGE": "docker.all-hands.dev/all-hands-ai/runtime:0.56-nikolaik",
        "LOG_ALL_EVENTS": "true",
        "CONFIG_FILE": "/custom/path/config.toml",
        "AGENT_LLM_CONFIG": module_name_replace  
    }

    

    ports = {'3000': app_data.port}

  
    
    config_full_path = os.path.abspath(os.path.join(task_workspace_path, "config.toml"))
    openhands_state_path = os.path.expanduser("~/.openhands")

    volumes = [
        (config_full_path, "/custom/path/config.toml", "ro"),  
        ("/var/run/docker.sock", "/var/run/docker.sock", "rw"),  # Docker socket
        (openhands_state_path, "/.openhands", "rw")  # OpenHands State Directory
    ]

    extra_hosts = {"host.docker.internal": "host-gateway"}


    container_name = f"openhands-app-{app_data.port}"

    # Setting the command to run when the container starts
    command = ['python', '-m', 'openhands.core.main', '--config-file=/custom/path/config.toml', '-t',
               'According to the start.md in the workspace, implement the entire project as per the requirements specified in the document, ensuring that the final product can be directly run in the current directory. The running requirements should comply with the <API Usage Guide> section of the document. Please complete this task step by step.']

    logger.info(f"Preparing to start container: {container_name}")
    logger.info(f"Config file path: {config_full_path}")
    logger.info(f"Port mapping: 3000 -> {app_data.port}")

    try:
        # Create and run the container
        container = create_advanced_container(
            host_info=app_data.host_info,
            image_name="docker.all-hands.dev/all-hands-ai/openhands:0.56",  # Image name
            container_name=container_name,  # Container name
            env_vars=env_vars,  # Environment variables
            ports=ports,  # Port mappings
            volumes=volumes,  # Volume mounts
            command=command,  # Command to run when the container starts
            auto_remove=True,  # (--rm)
            extra_hosts=extra_hosts,  # Extra host mappings
            pull_always=True  # Always pull image (--pull=always)
        )

        logger.info(f"Container {container_name} started successfully, container ID: {container.id}")

        # 将容器对象保存到app_data中
        app_data.container = container

        # 等待容器执行完成
        logger.info(f"Waiting for container {container_name} to complete execution...")

        exit_code = -1
        logs = ""

        try:
            # 由于设置了auto_remove=True，容器执行完成后会自动删除
            # 我们通过检查容器是否还存在来判断是否执行完成
            while True:
                try:
                    # 尝试刷新容器状态，如果容器已经被删除会抛出异常
                    container.reload()
                    # 如果没有异常，说明容器还在运行，等待一段时间后再检查
                    time.sleep(5)
                except Exception:
                    # 容器已经被自动删除，说明执行完成
                    logger.info(f"Container {container_name} has completed execution and been automatically removed")
                    break

            # 容器已经被删除，我们无法直接获取退出码
            # 但可以假设如果容器正常完成就是0，异常就是非0
            exit_code = 0  # 由于容器能够正常完成并被删除，假设为成功
            logger.info(f"Container {container_name} has completed execution successfully")

        except Exception as e:
            logger.error(f"Error occurred while monitoring container execution: {str(e)}")
            exit_code = -1

        
        logger.info("Start Post-processing")
        post_process_result = post_process_task(task_uuid, workspace_path, test_data, logger)

        if post_process_result['status'] == 'success':
            logger.info("Post-processing flow executed successfully")
            pytest_results = post_process_result['pytest_results']
            test_score = pytest_results['passed'] if pytest_results['total'] > 0 else 0
        else:
            logger.error(f"Post-processing flow execution failed: {post_process_result.get('error', 'Unknown error')}")
            test_score = 0


        return {
            'task_uuid': task_uuid,
            'workspace_path': workspace_path,
            'config_path': config_full_path,
            'test_data': test_data,
            'container_id': container.id,
            'container_name': container_name,
            'exit_code': exit_code,
            'module_name': app_data.module_name,
            'pro_name': pro_name,
            'port': app_data.port,
            'logs_length': len(logs) if logs else 0,
            'status': 'completed' if exit_code == 0 and post_process_result['status'] == 'success' else 'failed',
            'post_process_result': post_process_result,
            'test_score': test_score,
            'score': test_score  
        }

    except Exception as e:
        logger.error(f"Error occurred while creating or running container: {str(e)}")
        return {
            'task_uuid': task_uuid,
            'module_name': app_data.module_name,
            'pro_name': pro_name,
            'status': 'error',
            'error': str(e)
        }


# 任务分发总入口
def start_openhands(config: dict):
    logger.info("Start releasing openhands")
    # 打印配置信息
    max_pool_size = 10
    if "max_pool_size" in config.keys():
        max_pool_size = config["max_pool_size"]
        logger.info(f"Query configuration: max_pool_size: {max_pool_size}")
    else:
        logger.info(f"Configuration not found: max_pool_size, using default value: {max_pool_size}")

    # 先对数据进行分组，每组一个数据
    startPro = config["startPro"]
    task_list = []
    for pro in startPro:
        module_name = pro.get("moduleName", "")
        pro_name_list = pro.get("proNameList", [])
        base_url = pro.get("baseUrl") or pro.get("base_url", "")
        sk = pro.get("sk", "")

        for pro_name in pro_name_list:
            app_data = AppData(module_name, base_url, sk, len(task_list) + 3000, bo_size=1)
            app_data.pro_name_list.append(pro_name)
            task_list.append(app_data)
            logger.info(
                f"Query configuration: module_name: {module_name} - Found {len(pro_name_list)} projects, list: {json.dumps(pro_name_list)}")

    rest_list = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_pool_size) as executor:
        futures = [executor.submit(start_app, i) for i in task_list]

        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            if result:
                rest_list.append(result)
                status = result.get('status', 'unknown')
                module_name = result.get('module_name', 'unknown')
                pro_name = result.get('pro_name', 'unknown')


                task_uuid = result.get('task_uuid', 'unknown')
                test_score = result.get('test_score', 0)

                logger.info("=" * 60)
                logger.info(f"Task Execution Result Details - UUID: {task_uuid}")
                logger.info("=" * 60)
                logger.info(f"Model Name: {module_name}")
                logger.info(f"Task Name: {pro_name}")
                logger.info(f"Task Status: {status}")
                logger.info(f"Score: {test_score}")

                if status == 'completed':
                    logger.info(f"Task completed successfully")

                    # 详细打印成功信息
                    workspace_path = result.get('workspace_path', 'N/A')
                    config_path = result.get('config_path', 'N/A')
                    port = result.get('port', 'N/A')
                    container_name = result.get('container_name', 'N/A')

                    logger.info(f"Workspace Path: {workspace_path}")
                    logger.info(f"Config Path: {config_path}")
                    logger.info(f"Container Port: {port}")
                    logger.info(f"Container Name: {container_name}")

                    # 打印后处理结果
                    post_process_result = result.get('post_process_result', {})
                    if post_process_result:
                        logger.info("Post-Processing Results:")
                        logger.info(f"  ZIP File: {post_process_result.get('zip_path', 'N/A')}")
                        logger.info(f"  Log File: {post_process_result.get('log_path', 'N/A')}")
                        logger.info(f"  Test Image Tag: {post_process_result.get('test_image_tag', 'N/A')}")

                        # 打印pytest详细结果
                        pytest_results = post_process_result.get('pytest_results', {})
                        if pytest_results:
                            logger.info("Test Execution Details:")
                            logger.info(f"  Total Test Cases: {pytest_results.get('total', 0)}")
                            logger.info(f"  Passed Tests: {pytest_results.get('passed', 0)}")
                            logger.info(f"  Failed Tests: {pytest_results.get('failed', 0)}")
                            logger.info(f"  Errors: {pytest_results.get('errors', 0)}")
                            success_rate = pytest_results.get('success_rate', 0.0)
                            logger.info(f"  Pass Rate: {success_rate:.2%}")

                        # 打印命令执行情况
                        test_results = post_process_result.get('test_results', {})
                        command_results = test_results.get('command_results', [])
                        if command_results:
                            logger.info(f"Tested {len(command_results)} Commands:")
                            for i, cmd_result in enumerate(command_results):
                                cmd = cmd_result.get('command', 'N/A')
                                exit_code = cmd_result.get('exit_code', 'N/A')
                                logger.info(f"  Command {i + 1}: {cmd} Exit code: {exit_code})")

                elif status == 'failed':
                    logger.warning(f"Task Failed！")

                    # 详细打印失败信息
                    post_process_result = result.get('post_process_result', {})
                    if post_process_result and post_process_result.get('status') == 'error':
                        logger.warning(f"Post-Processing Failed: {post_process_result.get('error', 'Unknown error')}")
                        logger.warning(f"Log File: {post_process_result.get('log_path', 'N/A')}")

                elif status == 'error':
                    error_msg = result.get('error', 'unknown error')
                    logger.error(f"Error occurs！")
                    logger.error(f"Error Message: {error_msg}")
                else:
                    logger.info(f"Task Completed: {status}")

                logger.info("=" * 60)

               
                try:
                    
                    result_dir = "result"
                    os.makedirs(result_dir, exist_ok=True)

                   
                    save_data = result.copy()

                   
                    if 'test_data' in save_data:
                        test_data = save_data.pop('test_data')
                      
                        save_data['test_data_info'] = {
                            'pro_name': test_data.proName if hasattr(test_data, 'proName') else None,
                            'test_case_count': test_data.testCaseCount if hasattr(test_data, 'testCaseCount') else 0,
                            'test_shell_count': len(test_data.testShell) if hasattr(test_data,
                                                                                    'testShell') and test_data.testShell else 0,
                            'py_test_file_count': len(test_data.pyTestFileList) if hasattr(test_data,
                                                                                           'pyTestFileList') and test_data.pyTestFileList else 0
                        }

                  
                    save_data['saved_at'] = time.strftime('%Y-%m-%d %H:%M:%S')

                    
                    result_file_path = os.path.join(result_dir, f"{task_uuid}.json")

                    # Save to jsonfile
                    with open(result_file_path, 'w', encoding='utf-8') as f:
                        json.dump(save_data, f, indent=2, ensure_ascii=False, default=str)

                    logger.info(f"Task result save to: {result_file_path}")

                except Exception as save_e:
                    logger.error(f"Task result save failed: {str(save_e)}")
            else:
                logger.info("One publish task completed (no result set returned)")

    logger.info("All tasks completed!")
