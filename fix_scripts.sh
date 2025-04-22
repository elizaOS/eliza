#!/bin/bash

# Fix test scripts to ensure cleanup happens before exit

for script in packages/cli/__test_scripts__/test_{dev,env,install,plugin,project,start,test,update-cli,update}.sh; do
  echo "Fixing $script..."
  sed -i.bak -e '/exit 1/c\
    exit_code=1\
}\
\
# Clean up before exit\
cleanup_test_projects "$TEST_TMP_DIR"\
\
exit $exit_code
  ' -e '/exit 0/c\
    exit_code=0\
}\
\
# Clean up before exit\
cleanup_test_projects "$TEST_TMP_DIR"\
\
exit $exit_code
  ' "$script" && rm "${script}.bak"
done

echo "All scripts updated." 