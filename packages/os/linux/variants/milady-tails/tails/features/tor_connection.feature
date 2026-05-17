@product
Feature: Tor Connection helps the user in connecting to Tor
    As a Tails user
    I want to use Tor

    Background:
        Given I have started Tails from DVD without network and logged in

    Scenario: Starting Tor Connection before connecting to Wi-Fi
        When I start "Tor Connection" via GNOME Activities Overview
        Then the Tor Connection Assistant reports that I am not connected to a local network
        When I plug a Wi-Fi adapter
        Then Tor Connection suggests me to connect to Wi-Fi
        And I click on the Wi-Fi settings
        And The Wi-Fi settings are displayed

    # # this is not great, but it's the current status
    # Scenario: switching to a network with no Internet doesn't yield any error message
    #     Given the network is plugged
    #     And Tor is ready
    #     And I close "Tor Connection"
    #     When the network is unplugged
    #     And the Tor network and default bridges are blocked
    #     And I start "Tor Connection" via GNOME Activities Overview
    #     Then "Tor Connection" shows the success screen

    # Scenario: Close Tor Connection and open again
    #     Given Tor is ready
    #     When I close "Tor Connection"
    #     And I start "Tor Connection" via GNOME Activities Overview
    #     Then "Tor Connection" shows the success screen

    # regression test for #18868
    @slow @not_release_blocker @skip_by_default
    Scenario: Time syncing works even if the user waits a lot before connecting
        When the network is plugged
        And I wait 720 seconds
        Then I successfully configure Tor
        And the time has synced

    # regression test for #18546
    @not_release_blocker
    Scenario: Bridges are not enabled in automatic mode when going back from hiding Tor
        When the network is plugged
        And the Tor Connection Assistant autostarts
        And I look at the hide mode but then I go back
        And I choose to connect to Tor automatically
        Then Tor Connection does not propose me to use Tor bridges

    Scenario: I can use a network with captive portal
        Given the Tor network and default bridges are blocked
        And the network is plugged
        And I make sure time sync before Tor connects indicates a captive portal
        And the Tor Connection Assistant autostarts
        When I choose to connect to Tor automatically
        And I click "Connect to Tor"
        Then the Tor Connection Assistant fails to connect to Tor
        And the Tor Connection Assistant knows that it's not the time sync that failed
        And the Tor Connection Assistant knows that there might be a captive portal
        When I open the Unsafe Browser from Tor Connection
        And I log-in to the Captive Portal
        And I close the Unsafe Browser
        And the Tor network and default bridges are unblocked
        And I allow time sync before Tor connects to work again
        And I click "Connect to Tor"
        Then I wait until Tor is ready

