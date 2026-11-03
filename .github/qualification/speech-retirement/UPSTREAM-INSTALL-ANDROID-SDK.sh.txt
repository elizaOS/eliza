#!/bin/bash -e
################################################################################
##  File:  install-android-sdk.sh
##  Desc:  Install Android SDK and tools
################################################################################

# Source the helpers for use with the script
source $HELPER_SCRIPTS/os.sh
source $HELPER_SCRIPTS/install.sh
source $HELPER_SCRIPTS/etc-environment.sh

add_filtered_installation_components() {
    local minimum_version=$1
    shift
    local tools_array=("$@")

    for item in ${tools_array[@]}; do
        # Take the last version number that appears after the last '-' or ';'
        item_version=$(echo "$item" | grep -oE '[-;][0-9.]+' | grep -oE '[0-9.]+')

        # Semver 'comparison'. Add item to components array, if item's version is greater than or equal to minimum version
        if [[ "$(printf "${minimum_version}\n${item_version}\n" | sort -V | head -n1)" == "$minimum_version" ]]; then
            components+=($item)
        fi
    done
}

get_full_ndk_version() {
    local major_version=$1

    ndk_version=$($SDKMANAGER --list | grep "ndk;${major_version}\." | awk '{gsub("ndk;", ""); print $1}' | sort -V | tail -n1)
    echo "$ndk_version"
}

# Set env variable for SDK Root (https://developer.android.com/studio/command-line/variables)
ANDROID_ROOT=/usr/local/lib/android
ANDROID_SDK_ROOT=${ANDROID_ROOT}/sdk
SDKMANAGER=${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/sdkmanager
set_etc_environment_variable "ANDROID_SDK_ROOT" "${ANDROID_SDK_ROOT}"

# ANDROID_HOME is deprecated, but older versions of Gradle rely on it
set_etc_environment_variable "ANDROID_HOME" "${ANDROID_SDK_ROOT}"

# Create android sdk directory
mkdir -p ${ANDROID_SDK_ROOT}

# Download the latest command line tools so that we can accept all of the licenses.
# See https://developer.android.com/studio/#command-tools
cmdline_tools_package=$(get_toolset_value '.android."cmdline-tools"')
if [[ $cmdline_tools_version == "latest" ]]; then
    REPOSITORY_XML_URL="https://dl.google.com/android/repository/repository2-1.xml"
    repository_xml_file=$(download_with_retry "$REPOSITORY_XML_URL")
    cmdline_tools_package=$(
        yq -p=xml \
        '.sdk-repository.remotePackage[] | select(."+@path" == "cmdline-tools;latest" and .channelRef."+@ref" == "channel-0").archives.archive[].complete.url | select(contains("commandlinetools-linux"))' \
        "${repository_xml_file}"
    )

    if [[ -z $cmdline_tools_package ]]; then
        echo "Failed to parse latest command-line tools version"
        exit 1
    fi
fi

# Install command line tools
archive_path=$(download_with_retry "https://dl.google.com/android/repository/${cmdline_tools_package}")
unzip -qq "$archive_path" -d ${ANDROID_SDK_ROOT}/cmdline-tools
# Command line tools need to be placed in ${ANDROID_SDK_ROOT}/sdk/cmdline-tools/latest to determine SDK root
mv ${ANDROID_SDK_ROOT}/cmdline-tools/cmdline-tools ${ANDROID_SDK_ROOT}/cmdline-tools/latest

# Check sdk manager installation
if ${SDKMANAGER} --list 1>/dev/null; then
    echo "Android SDK manager was installed"
else
    echo "Android SDK manager was not installed"
    exit 1
fi

# Get toolset values and prepare environment variables
minimum_build_tool_version=$(get_toolset_value '.android.build_tools_min_version')
minimum_platform_version=$(get_toolset_value '.android.platform_min_version')
android_ndk_major_default=$(get_toolset_value '.android.ndk.default')
android_ndk_major_versions=($(get_toolset_value '.android.ndk.versions[]'))
android_ndk_major_latest=(${android_ndk_major_versions[-1]})

ndk_default_full_version=$(get_full_ndk_version $android_ndk_major_default)
ndk_latest_full_version=$(get_full_ndk_version $android_ndk_major_latest)
ANDROID_NDK=${ANDROID_SDK_ROOT}/ndk/${ndk_default_full_version}
# ANDROID_NDK, ANDROID_NDK_HOME, and ANDROID_NDK_ROOT variables should be set as many customer builds depend on them https://github.com/actions/runner-images/issues/5879
set_etc_environment_variable "ANDROID_NDK" "${ANDROID_NDK}"
set_etc_environment_variable "ANDROID_NDK_HOME" "${ANDROID_NDK}"
set_etc_environment_variable "ANDROID_NDK_ROOT" "${ANDROID_NDK}"
set_etc_environment_variable "ANDROID_NDK_LATEST_HOME" "${ANDROID_SDK_ROOT}/ndk/${ndk_latest_full_version}"

# Prepare components for installation
extras=$(get_toolset_value '.android.extra_list[] | "extras;" + .')
addons=$(get_toolset_value '.android.addon_list[] | "add-ons;" + .')
additional=$(get_toolset_value '.android.additional_tools[]')
components=("${extras[@]}" "${addons[@]}" "${additional[@]}")

for ndk_major_version in "${android_ndk_major_versions[@]}"; do
    ndk_full_version=$(get_full_ndk_version $ndk_major_version)
    components+=("ndk;$ndk_full_version")
done

available_platforms=($($SDKMANAGER --list | sed -n '/Available Packages:/,/^$/p' | grep "platforms;android-[0-9]" | cut -d"|" -f 1))
all_build_tools=($($SDKMANAGER --list | grep "build-tools;" | cut -d"|" -f 1 | sort -u))
available_build_tools=$(echo ${all_build_tools[@]//*rc[0-9]/})

add_filtered_installation_components $minimum_platform_version "${available_platforms[@]}"
add_filtered_installation_components $minimum_build_tool_version "${available_build_tools[@]}"

# Add platform tools to the list of components to install
components+=("platform-tools")

# Install components
echo "y" | $SDKMANAGER ${components[@]}

# Add required permissions
chmod -R a+rwx ${ANDROID_SDK_ROOT}

reload_etc_environment

invoke_tests "Android"
