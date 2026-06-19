*** Settings ***
Suite Setup       Setup
Suite Teardown    Teardown
Test Setup        Reset Emulation
Test Teardown     Test Teardown
Resource          ${RENODEKEYWORDS}

*** Variables ***
${SCRIPT}         ${CURDIR}/openphone_hello_tier2.resc
${UART}           sysbus.uart0
${PROMPT}         / #
${LINUX_BANNER}   openphone tier2: linux booted

*** Test Cases ***
Boot Tier2 Linux On Openphone Hello
    [Documentation]    Boots the OpenSBI+Linux+busybox tier-2 image on the
    ...                Renode model derived from sw/platform/hello_platform_contract.json
    Execute Command           include @${SCRIPT}
    Create Terminal Tester    ${UART}    timeout=60
    Start Emulation
    Wait For Line On Uart     ${LINUX_BANNER}    timeout=60
    Wait For Prompt On Uart   ${PROMPT}          timeout=60
