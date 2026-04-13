# Configuration of Docker

---

Welcome to the Docker VM Management documentation.

## Prerequisite: Check if your machine supports KVM

We recommend running the VM with KVM support. To check if your hosting platform supports KVM, run

```
egrep -c '(vmx|svm)' /proc/cpuinfo
```

on Linux. If the return value is greater than zero, the processor should be able to support KVM.

> **Note**: macOS hosts generally do not support KVM. You are advised to use VMware if you would like to run OSWorld on macOS.

## Install Docker

If your hosting platform supports graphical user interface (GUI), you may refer to [Install Docker Desktop on Linux](https://docs.docker.com/desktop/install/linux/) or [Install Docker Desktop on Windows](https://docs.docker.com/desktop/install/windows-install/) based on your OS.  Otherwise, you may [Install Docker Engine](https://docs.docker.com/engine/install/).

## Running Experiments

Add the following arguments when initializing `DesktopEnv`: 
- `provider_name`: `docker`
- `os_type`: `Ubuntu` or `Windows`, depending on the OS of the VM

Please allow for some time to download the virtual machine snapshot on your first run.
