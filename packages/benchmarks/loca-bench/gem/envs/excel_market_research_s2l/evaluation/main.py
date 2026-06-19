from argparse import ArgumentParser
import asyncio

# Use absolute import to avoid issues when running as subprocess
try:
    from .check_local import check_local
except ImportError:
    from check_local import check_local

if __name__=="__main__":
    parser = ArgumentParser()
    parser.add_argument("--agent_workspace", required=False)
    parser.add_argument("--groundtruth_workspace", required=False)
    parser.add_argument("--res_log_file", required=False, help='Path to result log file')
    parser.add_argument("--launch_time", required=False, help="Launch time")
    args = parser.parse_args()

    # check local
    try:
        local_pass, local_error = check_local(args.agent_workspace, args.groundtruth_workspace)
        if not local_pass:
            print("local check failed: ", local_error)
            exit(1)
    except Exception as e:
        print("local check error: ", e)
        exit(1)
    
    
    print("Pass all tests!") 