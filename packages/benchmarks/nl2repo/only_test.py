import concurrent
import time

from logging_config import get_logger
import json
import os
from openhands.openhands_app import start_openhands
import test_data_service
from openhands.post_processor import post_process_task
from test_data_service import TestData

logger = get_logger(__name__)


def start_test(workspace_name,test_data : TestData):
    try:
        workspace_path = os.path.join("workspaces", workspace_name, "workspace")
        post_process_result = post_process_task(workspace_name, workspace_path, test_data, logger)

        if post_process_result['status'] == 'success':
            logger.info("Post processing completed successfully")
            pytest_results = post_process_result['pytest_results']
            test_score = pytest_results['passed'] if pytest_results['total'] > 0 else 0
        else:
            logger.error(f"Post processing failed: {post_process_result.get('error', 'Unknown error')}")
            test_score = 0

        # Return task result
        return {
            'task_uuid': workspace_name,
            'workspace_path': workspace_path,
            'test_data': test_data,
            'pro_name': test_data.proName,
            'status': 'completed' if post_process_result['status'] == 'success' else 'failed',
            'post_process_result': post_process_result,
            'test_score': test_score,
            'score': test_score  
        }

    except Exception as e:
        logger.error(f"Error in start_test: {str(e)}")
        return {
            'task_uuid': workspace_name,
            'pro_name': test_data.proName,
            'status': 'error',
            'error': str(e)
        }


if __name__ == '__main__':
    logger.info("Start Running- (Only Test) ！")

    # Obtain test data
    test_data_service.read_all_test_data()

    test_data_list = test_data_service.test_data_list

    task_id = "6b4574e2-c164-4846-ae11-b54a42f577bc"
    pro_name = "math-verify"

    test_data = None

    for data in test_data_list:
        if data.proName == pro_name:
            test_data = data
            break

    start_test(task_id, test_data)

    logger.info("Test has been executed successfully！")
