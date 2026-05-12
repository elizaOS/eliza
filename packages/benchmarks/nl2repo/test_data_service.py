import os
import json
from logging_config import get_logger

logger = get_logger(__name__)

test_data_list = []


class TestData:
    """
    TestData Class

    """

    def __init__(self, pro_name, test_case_count, test_shell, py_test_file_list, image_tar, md):
        self.proName = pro_name
        self.testCaseCount = test_case_count
        self.testShell = test_shell
        self.pyTestFileList = py_test_file_list
        self.imageTar = image_tar
        self.md = md


def read_all_test_data():
    """
    Read all test data, add them to test_data_list.
    Test data folder is stored in ./test_files, each subfolder is a project, subfolder name is proName
    """
    test_files_path = "./test_files"

    # 检查 test_files 文件夹是否存在
    if not os.path.exists(test_files_path):
        logger.error(f"Test folder {test_files_path} does not exist")
        return

    # Validate each subfolder
    for project_folder in os.listdir(test_files_path):
        project_path = os.path.join(test_files_path, project_folder)

        # Ensure it's a directory
        if not os.path.isdir(project_path):
            continue

        logger.info(f"Processing project: {project_folder}")

        try:
            # Obtain all files in the project folder
            files_in_project = os.listdir(project_path)

            # Obtain test case count from txt file
            test_case_count = 0
            txt_files = [f for f in files_in_project if f.endswith('.txt')]
            if txt_files:
                count_file = os.path.join(project_path, txt_files[0])
                with open(count_file, 'r', encoding='utf-8') as f:
                    test_case_count = int(f.read().strip())
                logger.info(f"Project {project_folder} has {test_case_count} test cases (from file: {txt_files[0]})")
            else:
                logger.warning(f"Project {project_folder} is missing txt file")

            # 读取测试执行命令（从包含commands的json文件）
            test_shell = []
            commands_files = [f for f in files_in_project if f.endswith('.json') and 'commands' in f]
            if commands_files:
                commands_file = os.path.join(project_path, commands_files[0])
                with open(commands_file, 'r', encoding='utf-8') as f:
                    test_shell = json.load(f)
                logger.info(f"Project {project_folder} has test shell commands: {test_shell} (from file: {commands_files[0]})")
            else:
                logger.warning(f"Project {project_folder} is missing json file with commands")

            # Obtain test file list from json file with files
            py_test_file_list = []
            files_files = [f for f in files_in_project if f.endswith('.json') and 'files' in f]
            if files_files:
                files_file = os.path.join(project_path, files_files[0])
                with open(files_file, 'r', encoding='utf-8') as f:
                    py_test_file_list = json.load(f)
                logger.info(f"Project {project_folder} has test files: {py_test_file_list} (from file: {files_files[0]})")
            else:
                logger.warning(f"Project {project_folder} is missing json file with files")

            # Obtain tar file path(Optional, the image can also be pulled from remote)
            image_tar = ""
            tar_files = [f for f in files_in_project if f.endswith('.tar')]
            if tar_files:
                image_tar = os.path.join(project_path, tar_files[0])
                logger.info(f"Project {project_folder} has image tar file: {image_tar} (from file: {tar_files[0]})")
            else:
                logger.warning(f"Project {project_folder} is missing tar file")

            # Obtain md file path(Optional)
            md = ""
            md_files = [f for f in files_in_project if f.endswith('.md')]
            if md_files:
                md = os.path.join(project_path, md_files[0])
                logger.info(f"Project {project_folder} has repo file: {md} (from file: {md_files[0]})")
            else:
                logger.warning(f"Project {project_folder} is missing md file")

            # Create TestData object and add to list
            test_data = TestData(
                pro_name=str(project_folder),
                test_case_count=test_case_count,
                test_shell=test_shell,
                py_test_file_list=py_test_file_list,
                image_tar=image_tar,
                md=md
            )

            test_data_list.append(test_data)
            logger.info(f"Successfully added test data for project {project_folder}")

        except Exception as e:
            logger.error(f"Error processing project {project_folder}: {str(e)}")

    logger.info(f"Successfully loaded test data for {len(test_data_list)} projects")


if __name__ == '__main__':
    read_all_test_data()
