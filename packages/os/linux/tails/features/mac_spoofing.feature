@product
Feature: Spoofing MAC addresses
  In order to not reveal information about the physical location
  As a Tails user
  I want to be able to control whether my network devices MAC addresses should be spoofed
  And I want this feature to fail safe and notify me in case of errors

  Scenario: MAC address spoofing is disabled
    Given I have started Tails from DVD without network and stopped at Tails Greeter's login screen
    And I capture all network traffic
    When I disable MAC spoofing in Tails Greeter
    And I log in to a new session
    And the network is plugged
    And Tor is ready
    Then 1 network interface is enabled
    And the 1st network device has its real MAC address configured
    When I hotplug a network device and wait for it to be initialized
    Then 2 network interfaces are enabled
    And the 2nd network device has its real MAC address configured
    And some network device leaked the real MAC address

  Scenario: MAC address spoofing is successful
    Given I have started Tails from DVD without network and stopped at Tails Greeter's login screen
    And I capture all network traffic
    When I log in to a new session
    And the network is plugged
    And Tor is ready
    Then 1 network interface is enabled
    And the 1st network device has a spoofed MAC address configured
    When I hotplug a network device and wait for it to be initialized
    Then 2 network interfaces are enabled
    And the 2nd network device has a spoofed MAC address configured
    And no network device leaked the real MAC address

  Scenario: MAC address spoofing fails and macchanger returns false
    Given I have started Tails from DVD without network and stopped at Tails Greeter's login screen
    And I capture all network traffic
    And the network is plugged
    And macchanger will fail by not spoofing and always returns false
    When I log in to a new session
    Then no network interfaces are enabled
    And no network device leaked the real MAC address
    And I see the "Wired Network Disabled" notification after at most 60 seconds

  Scenario: MAC address spoofing fails and macchanger returns true
    Given I have started Tails from DVD without network and stopped at Tails Greeter's login screen
    And I capture all network traffic
    And the network is plugged
    And macchanger will fail by not spoofing and always returns true
    When I log in to a new session
    Then no network interfaces are enabled
    And no network device leaked the real MAC address
    And I see the "Wired Network Disabled" notification after at most 60 seconds

  Scenario: MAC address spoofing fails and the module is not removed
    Given I have started Tails from DVD without network and stopped at Tails Greeter's login screen
    And I capture all network traffic
    And the network is plugged
    And macchanger will fail by not spoofing and always returns true
    And no network interface modules can be unloaded
    When I log in to a new session
    Then 1 network interface is enabled
    But the MAC spoofing panic mode disabled networking
    And no network device leaked the real MAC address
    And I see the "All Networking Disabled" notification after at most 60 seconds

  Scenario: The MAC address is not leaked when booting Tails
    Given a computer
    And I capture all network traffic
    When I start the computer
    Then the computer boots Tails
    And no network interfaces are enabled
    And no network device leaked the real MAC address
