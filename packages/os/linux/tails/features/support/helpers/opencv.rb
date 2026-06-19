require 'English'
require 'open3'

class OpenCVInternalError < StandardError
end

module OpenCV
  def self.matchTemplate(image, screen, sensitivity, show_match, show_old)
    assert(sensitivity < 1.0)
    # Do a deep-copy so we don't mess up the outer environment
    env = Hash[ENV]
    if ENV['USER_DISPLAY'].nil? || ENV['USER_DISPLAY'] == ''
      show_match = false
    else
      env['DISPLAY'] = ENV['USER_DISPLAY']
    end
    # We will often kill the threads run by Open3 thanks to our
    # liberal use of try_for(), which raises an exception in those
    # threads. Since Ruby 2.5 those exceptions are reported to stderr
    # in the parent process, which will spam our log with useless
    # information, so we disable such reports temporarily.
    Thread.report_on_exception = false
    stdout, stderr, p = Open3.capture3(
      env, 'python3', "#{GIT_DIR}/features/scripts/opencv_match_template.py",
      screen, image, sensitivity.to_s, show_match.to_s, show_old.to_s
    )
    raise OpenCVInternalError, stderr if p.exitstatus != 0

    if stdout.chomp == 'FindFailed'
      nil
    else
      match = stdout.chomp.split.map(&:to_i)
      assert_equal(4, match.size)
      match
    end
  ensure
    Thread.report_on_exception = true
  end
end
