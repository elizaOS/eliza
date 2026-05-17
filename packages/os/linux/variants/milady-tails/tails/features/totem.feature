@product
Feature: Using Totem
  As a Tails user
  I want to watch local and remote videos in Totem
  And all Internet traffic should flow only through Tor

  Background:
    Given I create sample videos

  Scenario: Watching a MP4 video stored on the non-persistent filesystem
    Given I have started Tails from DVD without network and logged in
    And I plug and mount a USB drive containing sample videos
    And I copy the sample videos to "/home/amnesia" as user "amnesia"
    And the file "/home/amnesia/video.mp4" exists
    When I open "/home/amnesia/video.mp4" with Totem
    Then I see "SampleLocalMp4VideoFrame.png" after at most 40 seconds

  @check_tor_leaks
  Scenario: Watching a WebM video over HTTPS
    Given I have started Tails from DVD and logged in and the network is connected
    Then I can watch a WebM video over HTTPs

  Scenario: Watching MP4 videos stored in the Persistent Storage
    Given I have started Tails without network from a USB drive with a persistent partition enabled and logged in
    And I plug and mount a USB drive containing sample videos
    And I copy the sample videos to "/home/amnesia/Persistent" as user "amnesia"
    When I open "/home/amnesia/Persistent/video.mp4" with Totem
    Then I see "SampleLocalMp4VideoFrame.png" after at most 40 seconds
