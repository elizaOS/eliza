import hashlib
import logging
from os.path import abspath, dirname, join

BASE_DIR = dirname(abspath(__file__))
DEBUG_PROD_SIZE = None  # set to `None` to disable

DEFAULT_ATTR_PATH = join(BASE_DIR, "../data/items_ins_v2_1000.json")
DEFAULT_FILE_PATH = join(BASE_DIR, "../data/items_shuffle_1000.json")
# DEFAULT_ATTR_PATH = join(BASE_DIR, "../data/items_ins_v2.json")
# DEFAULT_FILE_PATH = join(BASE_DIR, "../data/items_shuffle.json")
DEFAULT_REVIEW_PATH = join(BASE_DIR, "../data/reviews.json")

FEAT_CONV = join(BASE_DIR, "../data/feat_conv.pt")
FEAT_IDS = join(BASE_DIR, "../data/feat_ids.pt")

HUMAN_ATTR_PATH = join(BASE_DIR, "../data/items_human_ins.json")
HUMAN_ATTR_PATH = join(BASE_DIR, "../data/items_human_ins.json")


def setup_logger(session_id, user_log_dir):
    """Creates a log file and logging object for the corresponding session ID"""
    logger = logging.getLogger(session_id)
    formatter = logging.Formatter("%(message)s")
    file_handler = logging.FileHandler(user_log_dir / f"{session_id}.jsonl", mode="w")
    file_handler.setFormatter(formatter)
    logger.setLevel(logging.INFO)
    logger.addHandler(file_handler)
    return logger


def generate_mturk_code(session_id: str) -> str:
    """Generates a redeem code corresponding to the session ID for an MTurk
    worker once the session is completed
    """
    sha = hashlib.sha1(session_id.encode())
    return sha.hexdigest()[:10].upper()
