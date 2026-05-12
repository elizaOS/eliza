import json
import re

from pathlib import Path
from swebench.harness.constants import (
    END_TEST_OUTPUT,
    START_TEST_OUTPUT,
)
from swebench.harness.test_spec.utils import make_eval_script_list_common
from unidiff import PatchSet


# MARK: Test Command Creation Functions
def get_test_cmds_calypso(instance) -> list:
    test_paths = [x.path for x in PatchSet(instance["test_patch"])]
    test_cmds = []
    for test_path in test_paths:
        if re.search(r"__snapshots__/(.*).js.snap$", test_path):
            # Jest snapshots are not run directly
            test_path = "/".join(test_path.split("/")[:-2])

        # Determine which testing script to use
        if any([test_path.startswith(x) for x in ["client", "packages"]]):
            pkg = test_path.split("/")[0]
            if instance["version"] in [
                "10.10.0",
                "10.12.0",
                "10.13.0",
                "10.14.0",
                "10.15.2",
                "10.16.3",
            ]:
                test_cmds.append(
                    f"./node_modules/.bin/jest --verbose -c=test/{pkg}/jest.config.js '{test_path}'"
                )
            elif instance["version"] in [
                "6.11.5",
                "8.9.1",
                "8.9.3",
                "8.9.4",
                "8.11.0",
                "8.11.2",
                "10.4.1",
                "10.5.0",
                "10.6.0",
                "10.9.0",
            ]:
                test_cmds.append(
                    f"./node_modules/.bin/jest --verbose -c=test/{pkg}/jest.config.json '{test_path}'"
                )
            else:
                test_cmds.append(f"npm run test-{pkg} --verbose '{test_path}'")
        elif any([test_path.startswith(x) for x in ["test/e2e"]]):
            test_cmds.extend(
                [
                    "cd test/e2e",
                    f"NODE_CONFIG_ENV=test npm run test {test_path}",
                    "cd ../..",
                ]
            )

    return test_cmds


MAP_REPO_TO_TEST_CMDS = {
    "Automattic/wp-calypso": get_test_cmds_calypso,
}


# MARK: Utility Functions
def get_download_img_commands(instance) -> list:
    cmds = []
    image_assets = {}
    if "image_assets" in instance:
        if isinstance(instance["image_assets"], str):
            image_assets = json.loads(instance["image_assets"])
        else:
            image_assets = instance["image_assets"]
    for i in image_assets.get("test_patch", []):
        folder = Path(i["path"]).parent
        cmds.append(f"mkdir -p {folder}")
        cmds.append(f"curl -o {i['path']} {i['url']}")
        cmds.append(f"chmod 777 {i['path']}")
    return cmds


# MARK: Script Creation Functions
def make_eval_script_list_js(
    instance, specs, env_name, repo_directory, base_commit, test_patch
) -> list:
    """
    Applies the test patch and runs the tests.
    """
    eval_commands = make_eval_script_list_common(
        instance, specs, env_name, repo_directory, base_commit, test_patch
    )
    # Insert downloading right after reset command
    eval_commands[4:4] = get_download_img_commands(instance)
    if instance["repo"] in MAP_REPO_TO_TEST_CMDS:
        # Update test commands if they are custom commands
        test_commands = MAP_REPO_TO_TEST_CMDS[instance["repo"]](instance)
        idx_start_test_out = eval_commands.index(f": '{START_TEST_OUTPUT}'")
        idx_end_test_out = eval_commands.index(f": '{END_TEST_OUTPUT}'")
        eval_commands[idx_start_test_out + 1 : idx_end_test_out] = test_commands
    return eval_commands
