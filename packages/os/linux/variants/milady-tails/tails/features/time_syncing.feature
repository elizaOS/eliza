@product @check_tor_leaks
Feature: Time syncing
  As a Tails user
  I want Tor to work properly
  And for that I need a reasonably accurate system clock

  Scenario: Clock with host's time
    Given I have started Tails from DVD without network and logged in
    When the network is plugged
    And I successfully configure Tor
    Then the system clock is less than 5 minutes incorrect

  Scenario: Clock with host's time while using bridges
    Given I have started Tails from DVD without network and logged in
    When the network is plugged
    And the Tor Connection Assistant autostarts
    And I configure some normal bridges in the Tor Connection Assistant
    And I wait until Tor is ready
    Then the system clock is less than 5 minutes incorrect

  Scenario: Clock is one day in the future while using obfs4 bridges
    Given I have started Tails from DVD without network and logged in
    When I bump the system time with "+1 day"
    And I capture all network traffic
    And the network is plugged
    And the Tor Connection Assistant autostarts
    And I configure some obfs4 bridges in the Tor Connection Assistant in easy mode
    And I wait until Tor is ready
    Then the system clock is less than 5 minutes incorrect
    And all Internet traffic has only flowed through the configured bridges or connectivity check service

  @not_release_blocker
  Scenario: The system time is not synced to the hardware clock
    Given I have started Tails from DVD without network and logged in
    When I bump the system time with "-15 days"
    And I warm reboot the computer
    And the computer reboots Tails
    Then Tails' hardware clock is close to the host system's time

  @not_release_blocker
  Scenario: Anti-test: Changes to the hardware clock are kept when rebooting
    Given I have started Tails from DVD without network and logged in
    When I bump the hardware clock's time with "-15 days"
    And I warm reboot the computer
    And the computer reboots Tails
    Then the hardware clock is still off by "-15 days"

  Scenario: The clock is set to the source date when the hardware clock is way in the past
    Given a computer
    And the hardware clock is set to "01 Jan 2000 12:34:56"
    And I start the computer
    And the computer boots Tails
    Then the system clock is just past Tails' source date

  Scenario: On a clock with host's time, Tor Connection works even if time sync fails
    Given I have started Tails from DVD without network and logged in
    And I make sure time sync before Tor connects times out
    When the network is plugged
    And I successfully configure Tor
    Then the system clock is less than 5 minutes incorrect

  Scenario: I can manually recover from time sync failure when connecting automatically to obfs4 bridges with a clock East of UTC
    Given I have started Tails from DVD without network and logged in
    When I bump the system time with "+8 hours +15 minutes"
    And all notifications have disappeared
    And I capture all network traffic
    And I make sure time sync before Tor connects fails
    And the network is plugged
    And the Tor Connection Assistant autostarts
    When I configure the default bridges in the Tor Connection Assistant in easy mode without connecting
    And I click "Connect to Tor"
    And the Tor Connection Assistant fails to connect to Tor
    # The "Fix Clock" button allows users to recover from this bug
    Then I set the time zone in Tor Connection to "Asia/Shanghai"
    Then the system clock is less than 20 minutes incorrect
    When I click "Connect to Tor"
    Then I wait until Tor is ready
    And all Internet traffic has only flowed through the default bridges or fake connectivity check service
    # check that htpdate has done its job
    And the system clock is less than 5 minutes incorrect

  Scenario: I can connect to obfs4 bridges having a clock East of UTC while hiding that I am using Tor
    Given I have started Tails from DVD without network and logged in
    When I bump the system time with "+8 hours +15 minutes"
    And all notifications have disappeared
    And I capture all network traffic
    And the network is plugged
    And the Tor Connection Assistant autostarts
    # Anti-test: Users east of UTC can't connect to obfs4 bridges
    And I configure some obfs4 bridges in the Tor Connection Assistant in hide mode without connecting
    And I click "Connect to Tor"
    Then the Tor Connection Assistant reports that it failed to connect
    # The "Fix Clock" button allows users to recover from this bug
    When I set the time zone in Tor Connection to "Asia/Shanghai"
    Then the system clock is less than 20 minutes incorrect
    # "Asia/Shanghai" is UTC+08:00 all year long (no DST)
    And the displayed clock is less than 20 minutes incorrect in "+08:00"
    When I click "Connect to Tor"
    Then I wait until Tor is ready
    And all Internet traffic has only flowed through the configured bridges
    # check that htpdate has done its job
    And the system clock is less than 5 minutes incorrect
    And the displayed clock is less than 5 minutes incorrect in "+08:00"

  Scenario: Time sync before Tor connects sets the same headers as the NetworkManager connectivity check
    Given I have started Tails from DVD without network and logged in
    And I make sure time sync before Tor connects uses a fake connectivity check service
    And the network is plugged
    And Tor is ready
    Then the fake connectivity check service has received a new HTTP request
    When I make NetworkManager perform a connectivity check
    Then the fake connectivity check service has received a new HTTP request
    And the HTTP requests received by the fake connectivity check service are identical
