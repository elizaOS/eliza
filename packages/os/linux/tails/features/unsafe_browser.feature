@product
Feature: Browsing the web using the Unsafe Browser
  As a Tails user
  when I browse the web using the Unsafe Browser
  I should have direct access to the web

  Scenario: The Unsafe Browser can be disabled
    Given I have started Tails from DVD without network and stopped at Tails Greeter's login screen
    And I disable the Unsafe Browser
    And I log in to a new session
    And the network is plugged
    And all notifications have disappeared
    When I try to start the Unsafe Browser
    Then the Unsafe Browser complains that it is disabled

  Scenario: The Unsafe Browser can access the LAN
    Given I have started Tails from DVD and logged in and the network is connected
    And a web server is running on the LAN
    When I successfully start the Unsafe Browser
    And I open a page on the LAN web server in the Unsafe Browser
    Then the Unsafe Browser displays the LAN web server hello message

  @doc
  Scenario: Starting the Unsafe Browser works as it should
    Given I have started Tails from DVD and logged in and the network is connected
    When I successfully start the Unsafe Browser
    Then the Unsafe Browser runs as the expected user
    And the Unsafe Browser has a red theme
    And the Unsafe Browser shows a warning as its start page
    And the Unsafe Browser has no add-ons installed
    And the Unsafe Browser has no bookmarks
    And the Unsafe Browser uses all expected TBB shared libraries

  @doc
  Scenario: The Unsafe Browser can load a web page from the Internet
    Given I have started Tails from DVD and logged in and the network is connected
    When I successfully start the Unsafe Browser
    When I open the Tails homepage in the Unsafe Browser
    Then the Tails homepage loads in the Unsafe Browser
    And the Unsafe Browser has sent packets out to the Internet

  @not_release_blocker
  Scenario: Closing the Unsafe Browser shows a stop notification and properly tears down the chroot
    Given I have started Tails from DVD and logged in and the network is connected
    When I successfully start the Unsafe Browser
    And I close the Unsafe Browser
    Then I see the "Shutting down the Unsafe Browser..." notification after at most 60 seconds
    And the Unsafe Browser chroot is torn down

  @not_release_blocker
  Scenario: Starting a second instance of the Unsafe Browser results in an error message being shown
    Given I have started Tails from DVD and logged in and the network is connected
    When I successfully start the Unsafe Browser
    # Wait for whatever facility the GNOME Activities Overview uses to
    # learn about which applications are running to "settle". Without
    # this sleep, it is confused and it's impossible to start a new
    # instance (it will just switch to the one we already started).
    And I wait 10 seconds
    And I try to start the Unsafe Browser
    Then I see a warning about another instance already running

  Scenario: The Unsafe Browser is not allowed to use a local proxy
    Given I have started Tails from DVD and logged in and the network is connected
    When I configure the Unsafe Browser to use a local proxy
    And I successfully start the Unsafe Browser
    And I open the Tails homepage in the Unsafe Browser
    Then the Unsafe Browser shows the "The proxy server is refusing connections" error

  @not_release_blocker @check_tor_leaks
  Scenario: The Unsafe Browser only makes user-initiated non-Torified connections
    Given I have started Tails from DVD and logged in and the network is connected
    And I capture all network traffic
    And I configure the Unsafe Browser to check for updates more frequently
    But checking for updates is disabled in the Unsafe Browser's configuration
    When I successfully start the Unsafe Browser
    And I wait 120 seconds
    Then the Unsafe Browser has not sent packets out to the Internet

  @not_release_blocker
  Scenario: The Unsafe Browser cannot be started when I am offline
    Given I have started Tails from DVD and logged in and the network is connected
    And the network is unplugged
    # NetworkManager apparently needs some time to notice that the connection is now off
    And I wait 10 seconds
    When I try to start the Unsafe Browser
    Then I am told I cannot start the Unsafe Browser when I am offline
