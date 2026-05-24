require 'resolv'
require 'uri'

Given /^I create sample videos$/ do
  @video_dir_on_host = "#{$config['TMPDIR']}/video_dir"
  FileUtils.mkdir_p(@video_dir_on_host)
  add_after_scenario_hook { FileUtils.rm_r(@video_dir_on_host) }
  fatal_system('ffmpeg -loop 1 -t 30 -f image2 ' \
               "-i 'features/images/USBTailsLogo.png' " \
               '-an -vcodec libx264 -y ' \
               '-filter:v "crop=in_w-mod(in_w\,2):in_h-mod(in_h\,2)" ' \
               "'#{@video_dir_on_host}/video.mp4' >/dev/null 2>&1")
end

Given /^I plug and mount a USB drive containing sample videos$/ do
  @video_dir_on_guest = share_host_files(
    Dir.glob("#{@video_dir_on_host}/*")
  )
end

Given /^I copy the sample videos to "([^"]+)" as user "([^"]+)"$/ do |destination, user|
  Dir.glob("#{@video_dir_on_host}/*.mp4").each do |video_on_host|
    video_name = File.basename(video_on_host)
    src_on_guest = "#{@video_dir_on_guest}/#{video_name}"
    dst_on_guest = "#{destination}/#{video_name}"
    step "I copy \"#{src_on_guest}\" to \"#{dst_on_guest}\" as user \"#{user}\""
  end
end

When /^I open "([^"]+)" with Totem$/ do |filename|
  step "I run \"totem #{filename}\" in Console"
end

When /^I close Totem$/ do
  ensure_process_is_terminated('totem')
end

Then /^I can watch a WebM video over HTTPs$/ do
  test_url = WEBM_VIDEO_URL

  # These tricks are needed because on Jenkins, tails.net
  # resolves to a RFC 1918 address (#10442), which tor would not allow
  # connecting to, and the firewall leak checker would make a fuss
  # out of it.
  host = URI(test_url).host
  allow_connecting_to_possibly_rfc1918_host(host)

  recovery_on_failure = proc do
    step 'I close Totem'
  end
  retry_tor(recovery_on_failure) do
    step "I open \"#{test_url}\" with Totem"
    @screen.wait('SampleRemoteWebMVideoFrame.png', 120)
  end
end
