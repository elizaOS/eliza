from logging_config import get_logger
import json
from openhands.openhands_app import start_openhands
import test_data_service

logger = get_logger(__name__)



if __name__ == '__main__':
    logger.info("Start Running openhands ！")


    # 获取测试数据
    test_data_service.read_all_test_data()

    test_data_list = test_data_service.test_data_list

    with open("config.json", 'r', encoding='utf-8') as f:
        conf = json.load(f)
    # Launch openhands
    start_openhands(conf)


    logger.info("openhands has been executed successfully！")

