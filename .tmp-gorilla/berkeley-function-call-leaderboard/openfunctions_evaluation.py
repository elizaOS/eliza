from bfcl_eval._llm_response_generation import get_args, main
from bfcl_eval.constants.eval_config import DOTENV_PATH
from dotenv import load_dotenv

# Note: This file is still kept for compatibility with the old structure of the codebase.
# It is recommended to use the new `bfcl xxx` cli commands instead.
# We will remove this in the next major release.
if __name__ == "__main__":
    load_dotenv(dotenv_path=DOTENV_PATH, verbose=True, override=True)  # Load the .env file

    main(get_args())
