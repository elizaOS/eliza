@product
Feature: Browsing the web using the Tor Browser
  As a Tails user
  when I browse the web using the Tor Browser
  all Internet traffic should flow only through Tor

  Scenario: The Tor Browser cannot access the LAN
    Given I have started Tails from DVD and logged in and the network is connected
    And a web server is running on the LAN
    And I capture all network traffic
    When I start the Tor Browser
    And I open a page on the LAN web server in the Tor Browser
    Then the Tor Browser shows the "Unable to connect" error
    And no traffic was sent to the web server on the LAN

  @check_tor_leaks
  Scenario: The Downloads directory is usable in Tor Browser
    Given I have started Tails from DVD and logged in and the network is connected
    Then the live user's Downloads directory exists
    And there is a GNOME bookmark for the Downloads directory
    When I start the Tor Browser
    Then I can save the current page as "index.html" to the Downloads directory
    And I can print the current page as "output.pdf" to the Downloads directory

  @check_tor_leaks
  Scenario: Downloading files with the Tor Browser
    Given I have started Tails from DVD and logged in and the network is connected
    When I start the Tor Browser
    When I download some file in the Tor Browser to the Downloads directory
    Then the file is saved to the Downloads directory

  @check_tor_leaks
  Scenario: Playing an Ogg audio track
    Given I have started Tails from DVD and logged in and the network is connected
    When I start the Tor Browser
    Then I can listen to an Ogg audio track in Tor Browser

  @check_tor_leaks
  Scenario: Watching a WebM video
    Given I have started Tails from DVD and logged in and the network is connected
    When I start the Tor Browser
    Then I can watch a WebM video in Tor Browser

  Scenario: I can view a file stored in "~/Downloads" but not in ~/.gnupg
    Given I have started Tails from DVD and logged in and the network is connected
    And I copy "/usr/share/synaptic/html/index.html" to "/home/amnesia/Downloads/synaptic.html" as user "amnesia"
    And I copy "/usr/share/synaptic/html/index.html" to "/home/amnesia/.gnupg/synaptic.html" as user "amnesia"
    And I copy "/usr/share/synaptic/html/index.html" to "/tmp/synaptic.html" as user "amnesia"
    Then the file "/home/amnesia/.gnupg/synaptic.html" exists
    And the file "/lib/live/mount/overlay/rw/home/amnesia/.gnupg/synaptic.html" exists
    And the file "/live/overlay/rw/home/amnesia/.gnupg/synaptic.html" exists
    And the file "/tmp/synaptic.html" exists
    Given I start monitoring the AppArmor log of "torbrowser_firefox"
    When I start the Tor Browser
    And I open the address "file:///home/amnesia/Downloads/synaptic.html" in the Tor Browser
    Then I see "TorBrowserSynapticManual.png" after at most 5 seconds
    And AppArmor has not denied "torbrowser_firefox" from opening "/home/amnesia/Downloads/synaptic.html"
    When I open the address "file:///home/amnesia/.gnupg/synaptic.html" in the Tor Browser
    Then I do not see "TorBrowserSynapticManual.png" after at most 5 seconds
    When I open the address "file:///lib/live/mount/overlay/rw/home/amnesia/.gnupg/synaptic.html" in the Tor Browser
    Then I do not see "TorBrowserSynapticManual.png" after at most 5 seconds
    When I open the address "file:///live/overlay/rw/home/amnesia/.gnupg/synaptic.html" in the Tor Browser
    Then I do not see "TorBrowserSynapticManual.png" after at most 5 seconds
    When I open the address "file:///tmp/synaptic.html" in the Tor Browser
    Then I do not see "TorBrowserSynapticManual.png" after at most 5 seconds

  Scenario: The Tor Browser uses TBB's shared libraries
    Given I have started Tails from DVD and logged in and the network is connected
    When I start the Tor Browser
    Then the Tor Browser uses all expected TBB shared libraries

  @check_tor_leaks
  Scenario: The Tor Browser's "New identity" feature works as expected
    Given I have started Tails from DVD and logged in and the network is connected
    When I start the Tor Browser
    When I open the address "https://example.com/" in the Tor Browser
    Then Tor Browser displays a "Example Domain" heading on the "Example Domain" page
    And the Tor Browser has 2 tabs open
    When I request a new identity in Tor Browser
    Then the Tor Browser loads about:tor
    And the Tor Browser has 1 tab open

  # If you think that the "the Tor Browser loads the Tails homepage" implies @doc, think
  # again: it depends on reaching the public website, not on using the copy of the
  # website which is bundled in.
  Scenario: The Tor Browser's circuit view feature works as expected
    Given I have started Tails from DVD and logged in and the network is connected
    When I start the Tor Browser
    And I open the Tails homepage in the Tor Browser
    Then the Tor Browser loads the Tails homepage
    And Tor Browser's circuit view is working

  Scenario: WebRTC is disabled in Tor Browser
    Given I have started Tails from DVD and logged in and the network is connected
    When I start the Tor Browser
    When I open the address "https://net.ipcalf.com/" in the Tor Browser
    Then Tor Browser displays a 'ifconfig | grep inet | grep -v inet6 | cut -d" " -f2 | tail -n1' heading on the "Network IP Address via ipcalf.com" page
    When I open the address "https://mozilla.github.io/webrtc-landing/pc_test.html" in the Tor Browser
    Then Tor Browser displays a "RTCPeerConnection is missing!" heading on the "Simple RTCPeerConnection Video Test" page

  Scenario: The Persistent directory is usable in Tor Browser
    Given I have started Tails without network from a USB drive with a persistent partition enabled and logged in
    And the network is plugged
    And I successfully configure Tor
    And available upgrades have been checked
    And all notifications have disappeared
    And there is a GNOME bookmark for the Persistent directory
    When I start the Tor Browser
    And I download some file in the Tor Browser to the Persistent directory
    Then the file is saved to the Persistent directory
    When I open the address "https://tails.net/about" in the Tor Browser
    Then "Tails - How Tails works" has loaded in the Tor Browser
    And I can print the current page as "output.pdf" to the Persistent directory

  Scenario Outline: The default XDG directories are usable in Tor Browser
    Given I have started Tails from DVD without network and logged in
    Then the live user's <dir> directory exists
    And there is a GNOME bookmark for the <dir> directory
    Then I start the Tor Browser in offline mode
    And I can save the current page as "index.html" to the <dir> GNOME bookmark
    Examples:
      | dir |
      | Documents |
      | Downloads |
      | Music |
      | Pictures |
      | Videos |

  Scenario: Persistent browser bookmarks
    Given I have started Tails without network from a USB drive with a persistent partition enabled and logged in
    And all tps features are active
    And all persistent filesystems have safe access rights
    And all persistence configuration files have safe access rights
    And all persistent directories have safe access rights
    When I start the Tor Browser in offline mode
    And I add a bookmark to eff.org in the Tor Browser
    And I cold reboot the computer
    And the computer reboots Tails
    And I enable persistence
    And I log in to a new session
    And all notifications have disappeared
    And I start the Tor Browser in offline mode
    Then the Tor Browser has a bookmark to eff.org
