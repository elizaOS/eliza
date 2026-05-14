sudo_cmd=""
if [ "$(id -u)" != "0" ]; then
    sudo_cmd="sudo"
    sudo -k
fi

STARTUP_SCRIPT="/etc/startup.sh"
bash "${STARTUP_SCRIPT}"

SUBMIT_JOBS_SCRIPT="/etc/submit_jobs.sh"
bash "${SUBMIT_JOBS_SCRIPT}"