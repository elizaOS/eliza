require 'fileutils'
require 'rb-inotify'
require 'time'
require 'tmpdir'
require "#{GIT_DIR}/features/support/monkeypatches/extra_hooks.rb"

# Run once, before any feature
AfterConfiguration do |config|
  puts("Cucumber tags: #{config.tag_expressions}")

  # We'll need access to cucumber's options in some places where
  # @__cucumber_runtime (which has a reference to it) is awkward to
  # access, so we make a global reference to them for those
  # situations.
  # Note that we use `instance_variable_get` to work around this
  # warning:
  #
  #     Deprecated: Configuration#options will be removed from the
  #     next release of Cucumber. Please use the configuration object
  #     directly instead.
  #
  # We'll revisit what to do then.
  $cucumber_options = config.instance_variable_get('@options')

  # Reorder the execution of some features. As we progress through a
  # run we accumulate more and more snapshots and hence use more and
  # more disk space, but some features will leave nothing behind
  # and/or possibly use large amounts of disk space temporarily for
  # various reasons. By running these first we minimize the amount of
  # disk space needed.
  prioritized_features = [
    # Features not using snapshots but using large amounts of scratch
    # space for other reasons:
    'features/untrusted_partitions.feature',
    # Features using temporary snapshots:
    'features/root_access_control.feature',
    'features/time_syncing.feature',
    'features/tor_bridges.feature',
    # Features using large amounts of scratch space for other reasons:
    'features/erase_memory.feature',
    # This feature needs the almost biggest snapshot (USB install,
    # excluding persistence) and will create yet another disk and
    # install Tails on it. This should be the peak of disk usage.
    'features/usb_install.feature',
    # This feature uses a few temporary snapshots, a network-enabled
    # snapshot, and a large disk.
    'features/additional_software_packages.feature',
    # This feature needs a copy of the ISO and creates a new disk.
    'features/usb_upgrade.feature',
    # This feature needs a very big snapshot (USB install with persistence)
    # and another, network-enabled snapshot.
    'features/emergency_shutdown.feature',
  ]
  feature_files = config.feature_files
  # The &-intersection is specified to keep the element ordering of
  # the *left* operand.
  intersection = prioritized_features & feature_files
  unless intersection.empty?
    feature_files -= intersection
    feature_files = intersection + feature_files
    config.define_singleton_method(:feature_files) { feature_files }
  end

  # Used to keep track of when we start our first @product feature, when
  # we'll do some special things.
  $started_first_product_feature = false

  if File.exist?($config['TMPDIR'])
    unless File.directory?($config['TMPDIR'])
      raise "Temporary directory '#{$config['TMPDIR']}' exists but is not a " \
            'directory'
    end
    unless File.owned?($config['TMPDIR'])
      raise "Temporary directory '#{$config['TMPDIR']}' must be owned by the " \
            'current user'
    end
    FileUtils.chmod(0o755, $config['TMPDIR'])
  else
    begin
      FileUtils.mkdir_p($config['TMPDIR'])
    rescue Errno::EACCES => e
      raise "Cannot create temporary directory: #{e}"
    end
  end

  if config_bool('INTERACTIVE_DEBUGGING')
    # This module extends exceptions so they contain the stack of
    # bindings for all callers from the point that it was raised,
    # which we use to restore the context of the failure when
    # --interactive-debugging is enabled.
    # BTW, upstream renamed the module to skiptrace five years ago but
    # hasn't done any release since then.
    require 'bindex'
  end
end

# Common
########

After do
  @after_scenario_hooks&.each(&:call)
  @after_scenario_hooks = []
end

BeforeFeature('@product', '@source') do |feature|
  raise "Feature #{feature.file} is tagged both @product and @source, " \
        'which is an impossible combination'
end

at_exit do
  $vm&.destroy_and_undefine
  if $virt
    unless KEEP_SNAPSHOTS
      VM.remove_all_snapshots
      $vmstorage&.clear_pool
    end
    $vmnet&.destroy_and_undefine
    $virt.close
  end
  # The artifacts directory is empty (and useless) if it contains
  # nothing but the mandatory . and ..
  FileUtils.rmdir(ARTIFACTS_DIR) if Dir.entries(ARTIFACTS_DIR).size <= 2
end

# For @product tests
####################

def add_after_scenario_hook(&block)
  @after_scenario_hooks ||= []
  @after_scenario_hooks << block
end

def save_failure_artifact(desc, path, suffix: nil)
  suffix ||= File.extname(path)
  $failure_artifacts << [desc, path, suffix]
end

def record_scenario_skipped(scenario)
  destfile = "#{ARTIFACTS_DIR}/skipped.txt"
  File.open(destfile, 'a') { |f| f.write("#{scenario.location}\n") }
end

def _save_vm_file_content(file:, destfile:, suffix:, desc:)
  destfile = "#{$config['TMPDIR']}/#{destfile}"
  File.open(destfile, 'w') { |f| f.write($vm.file_content(file)) }
  save_failure_artifact(desc, destfile, suffix:)
rescue StandardError => e
  info_log("Exception thrown while trying to save #{destfile}: " \
           "#{e.class.name}: #{e}")
end

def save_vm_command_output(command:, id:, suffix: nil, desc: nil) # rubocop:disable Naming/MethodParameterName
  suffix ||= ".cmd_output_#{id}"
  basename = "artifact#{suffix}"
  $vm.execute("#{command} > /tmp/#{basename} 2>&1")
  _save_vm_file_content(
    file:     "/tmp/#{basename}",
    destfile: basename,
    suffix:,
    desc:     desc || "Output of #{command}"
  )
end

def save_journal
  save_failure_artifact(
    'systemd Journal',
    JournalDumper.instance.path,
    suffix: '.journal'
  )
end

def save_vm_file_content(file, desc: nil, suffix: nil)
  suffix ||= ".file_content_#{file.gsub('/', '_').sub(/^_/, '')}"
  _save_vm_file_content(
    file:,
    destfile: "artifact#{suffix}",
    suffix:,
    desc:     desc || "Content of #{file}"
  )
end

def save_boot_log
  save_vm_file_content('/var/log/boot.log', desc: 'Boot log')
end

# Due to Tails' Tor enforcement, we only allow contacting hosts that
# are Tor nodes, located on the LAN, or allowed for some operational reason.
# However, when we try to verify that only such hosts are contacted we have
# a problem -- we run all Tor nodes (via Chutney) *and* LAN hosts (used on
# some tests) on the same host, the one running the test suite. Hence we
# need to always explicitly track which nodes are allowed or not.
#
# Warning: when a host is added via this function, it is only added
# for the current scenario. As such, if this is done before saving a
# snapshot, it will not remain after the snapshot is loaded.
def add_extra_allowed_host(ipaddr, port)
  @extra_allowed_hosts ||= []
  @extra_allowed_hosts << { address: ipaddr, port: }
end

def add_dns_to_extra_allowed_host
  # Allow connections to the local DNS resolver
  add_extra_allowed_host($vmnet.bridge_ip_address.to_s, 53)
end

BeforeFeature('@product') do
  images = { 'ISO' => TAILS_ISO, 'IMG' => TAILS_IMG }
  images.each do |type, path|
    if path.nil?
      raise "No Tails #{type} image specified, and none could be found " \
            'in the current directory'
    end

    unless File.exist?(path)
      raise "The specified Tails #{type} image '#{path}' does not exist"
    end

    if File.directory?(path)
      raise "The specified Tails #{type} image '#{path}' is a directory"
    end

    # Workaround: when libvirt takes ownership of the ISO/IMG image it may
    # become unreadable for the live user inside the guest in the
    # host-to-guest share used for some tests.

    unless File.world_readable?(path)
      if File.owned?(path)
        File.chmod(0o644, path)
      else
        raise "warning: the Tails #{type} image must be world readable " \
              'or be owned by the current user to be available inside ' \
              'the guest VM via host-to-guest shares, which is required ' \
              'by some tests'
      end
    end
  end
  unless File.exist?(OLD_TAILS_ISO)
    raise "The specified old Tails ISO image '#{OLD_TAILS_ISO}' does not exist"
  end
  unless File.exist?(OLD_TAILS_IMG)
    raise "The specified old Tails IMG image '#{OLD_TAILS_IMG}' does not exist"
  end

  unless $started_first_product_feature
    $virt = Libvirt.open('qemu:///system')
    VM.remove_all_snapshots unless KEEP_SNAPSHOTS
    $vmnet = VMNet.new($virt, VM_XML_PATH)
    $vmstorage = VMStorage.new($virt, VM_XML_PATH)
    $started_first_product_feature = true
  end
  initialize_chutney unless config_bool('DISABLE_CHUTNEY')
end

AfterFeature('@product') do
  unless KEEP_SNAPSHOTS
    CHECKPOINTS
      .select   { |name, vals| vals[:temporary] && VM.snapshot_exists?(name) }
      .each_key { |name| VM.remove_snapshot(name) }
  end
  $vmstorage
    .list_volumes
    .reject { |vol_name| vol_name == '__internal' }
    .each   { |vol_name| $vmstorage.delete_volume(vol_name) }
end

Before do |scenario|
  @scenario = scenario
end

# Cucumber Before hooks are executed in the order they are listed, and
# we want this hook to always run first, so it must always be the
# *first* Before hook matching @product listed in this file.
Before('@product') do |scenario|
  $failure_artifacts = []
  if config_bool('CAPTURE')
    video_name = sanitize_filename("#{scenario.name}.mkv")
    @video_path = "#{ARTIFACTS_DIR}/#{video_name}"
    debug_log("Starting video capture of '#{@video_path}'")
    capture = IO.popen(
      [
        'ffmpeg',
        '-f', 'x11grab',
        '-s', '1024x768',
        '-r', '15',
        '-i', "#{$config['DISPLAY']}.0",
        '-an',
        '-c:v', 'libx264',
        '-y',
        @video_path,
      ],
      in:  ['/dev/null', 'r'],
      err: ['/dev/null', 'w']
    )
    @video_capture_pid = capture.pid
  end

  if config_bool('ALWAYS_SAVE_JOURNAL')
    journal_path = sanitize_filename("#{scenario.name}.journal")
    JournalDumper.instance.path = "#{ARTIFACTS_DIR}/#{journal_path}"
  end

  @screen = if config_bool('IMAGE_BUMPING_MODE')
              ImageBumpingScreen.new
            else
              Screen.new
            end
  @real_tor = config_bool('DISABLE_CHUTNEY')
  # English will be assumed if this is not overridden
  $language = ''
  $lang_code = ''
  @os_loader = 'MBR'
  # Passwords includes shell-special chars (space, "!")
  # as a regression test for #17792
  @sudo_password = 'asdf !'
  @persistence_password = 'asdf !'
  @changed_persistence_password = 'foo123'
  @has_been_reset = false
  # See comment for add_extra_allowed_host() above.
  @extra_allowed_hosts ||= []

  @user_wants_pluggable_transports = false
  @tor_network_is_blocked = false
end

# Cucumber After hooks are executed in the *reverse* order they are
# listed, and we want this hook to always run second last, so it must always
# be the *second* After hook matching @product listed in this file --
# hooks added dynamically via add_after_scenario_hook() are supposed to
# truly be last.
# rubocop:disable Metrics/BlockNesting
After('@product') do |scenario|
  # we want this to always exist, even if it's empty
  FileUtils.touch("#{ARTIFACTS_DIR}/skipped.txt")

  if @video_capture_pid
    # We can be incredibly fast at detecting errors sometimes, so the
    # screen barely "settles" when we end up here and kill the video
    # capture. Let's wait a few seconds more to make it easier to see
    # what the error was.
    sleep 3 if scenario.failed?
    debug_log("Stopping video capture of '#{@video_path}'")
    Process.kill('INT', @video_capture_pid)
    Process.wait(@video_capture_pid)
    save_failure_artifact('Video', @video_path)
  end
  if scenario.failed? || config_bool('COLLECT_ALWAYS')
    time_of_fail = Time.now - TIME_AT_START
    secs = format('%<secs>02d', secs: time_of_fail % 60)
    mins = format('%<mins>02d', mins: (time_of_fail / 60) % 60)
    hrs  = format('%<hrs>02d',  hrs: time_of_fail / (60 * 60))
    elapsed = "#{hrs}:#{mins}:#{secs}"
    if scenario.failed?
      info_log("SCENARIO FAILED: '#{scenario.name}' (at time #{elapsed})")
    end
    save_journal
    unless $vm.display.nil?
      screenshot_path = sanitize_filename("#{scenario.name}.png")
      $vm.display.screenshot(screenshot_path)
      save_failure_artifact('Screenshot', screenshot_path)
    end
    if scenario.exception.is_a?(FirewallAssertionFailedError)
      Dir.glob("#{$config['TMPDIR']}/*.pcap").each do |pcap_file|
        save_failure_artifact('Network capture', pcap_file)
      end
    elsif scenario.exception.is_a?(TestSuiteRuntimeError)
      info_log("Scenario must be retried: #{scenario.name}")
      record_scenario_skipped(scenario)
    elsif [ChutneyBootstrapFailure, TorBootstrapFailure, TimeSyncingError].any? \
          { |c| scenario.exception.is_a?(c) }
      if scenario.exception.is_a?(ChutneyBootstrapFailure)
        # If Chutney fails to bootstrap all tests using the network
        # will fail, so let's signal to Cucumber that we want to quit
        # early. We do it using the same mechanism that is used by
        # Cucumber's --fail-fast option (see the fail_fast formatter,
        # /usr/lib/ruby/vendor_ruby/cucumber/formatter/fail_fast.rb)
        # to quit before running the next scenario.
        Cucumber.wants_to_quit = true
      end
      if File.exist?("#{$config['TMPDIR']}/chutney-data")
        chutney_artifact_dir = "#{ARTIFACTS_DIR}/chutney-data"
        chutney_scenario_symlink = "#{ARTIFACTS_DIR}/" + sanitize_filename(
          "#{elapsed}_#{scenario.name}_chutney-data"
        )
        FileUtils.rm(Dir.glob("#{$config['TMPDIR']}/chutney-data/**/control"))
        FileUtils.rm_rf(chutney_artifact_dir)
        FileUtils.mkdir(chutney_artifact_dir)
        begin
          FileUtils.copy_entry(
            "#{$config['TMPDIR']}/chutney-data",
            chutney_artifact_dir
          )
        rescue StandardError => e
          info_log("Failed to copy Chutney data: #{e}")
        end
        File.symlink('./chutney-data', chutney_scenario_symlink)
        info_log
        info_log_artifact_location('Chutney logs', chutney_scenario_symlink)
      else
        info_log('Found no Chutney data')
      end

      if $vm&.remote_shell_is_up?
        save_tor_journal
        save_failure_artifact('Tor logs', "#{$config['TMPDIR']}/log.tor")
        if $vm.file_exist?('/var/lib/tor/pt_state/obfs4proxy.log')
          File.open("#{$config['TMPDIR']}/log.obfs4proxy", 'w') do |f|
            f.write($vm.file_content('/var/lib/tor/pt_state/obfs4proxy.log'))
          end
          save_failure_artifact('obfs4proxy logs',
                                "#{$config['TMPDIR']}/log.obfs4proxy")
        end

        if scenario.exception.instance_of?(HtpdateError)
          content = if $vm.file_exist?('/var/log/htpdate.log')
                      $vm.file_content('/var/log/htpdate.log')
                    else
                      "The htpdate logs did not exist\n"
                    end
          File.write("#{$config['TMPDIR']}/log.htpdate", content)
          save_failure_artifact('Htpdate logs', "#{$config['TMPDIR']}/log.htpdate")
        end
      end
    end
    # Note that the remote shell isn't necessarily running at all
    # times a scenario can fail (and a scenario failure could very
    # well cause the remote shell to not respond any more, e.g. when
    # we cause a system crash), so let's collect everything depending
    # on the remote shell here:
    if $vm&.remote_shell_is_up?
      save_boot_log
      if scenario.feature.file \
         == 'features/additional_software_packages.feature'
        save_vm_command_output(
          command: 'ls -lAR --full-time /var/cache/apt',
          id:      'var_cache_apt'
        )
        save_vm_command_output(
          command: 'ls -lAR --full-time /var/lib/apt',
          id:      'var_lib_apt'
        )
        save_vm_command_output(
          command: 'mount',
          id:      'mount'
        )
        # When removing the logging below, also revert commit
        # c8429eecf23570274b0bb2134a87ae1fcf72ce07
        save_vm_command_output(
          command: 'ls -lA --full-time /live/persistence/TailsData_unlocked',
          id:      'persistent_volume'
        )
        save_vm_file_content('/run/live-additional-software/log')
      end
    end
    # We give JournalDumper a little time to receive the journal
    # entries for any remote shell interactions above before stopping
    # it and saving the journal.
    sleep 1
    JournalDumper.instance.stop
    $failure_artifacts.sort!
    $failure_artifacts.each do |desc, file, suffix|
      artifact_name = sanitize_filename(
        "#{elapsed}_#{scenario.name}#{suffix}"
      )
      artifact_path = "#{ARTIFACTS_DIR}/#{artifact_name}"
      assert(File.exist?(file))
      FileUtils.mv(file, artifact_path)
      info_log
      info_log_artifact_location(desc, artifact_path)
    end
    if config_bool('INTERACTIVE_DEBUGGING')
      pause('Interactive debugging', exception: scenario.exception)
    end
  elsif @video_path && File.exist?(@video_path) && !config_bool('CAPTURE_ALL')
    FileUtils.rm(@video_path)
  end
ensure
  # If there are uncaught exceptions during the After hook (which
  # happens sometimes, e.g. if the remote shell crashes) we still want
  # to ensure that we do the things necessary to prevent leftovers
  # from this scenario to interfere with the next scenario. Here we
  # take extra care to prevent uncaught exceptions so as many of these
  # are run as possible.

  begin
    # We don't want a stray JournalDumper thread from a previous
    # scenario interfering with a new thread it starts for a
    # subsequent scenario.
    JournalDumper.instance.stop
  rescue StandardError
    # At least we tried!
  end

  begin
    if $vm&.remote_shell_is_up?
      # We gracefully stop tor in order to make the bridges/guards not
      # keep sending packets that has a potential to bleed into the
      # next scenario. It has been observed that this can cause the
      # system under testing to send a TCP RST to the bridge/guard,
      # which then may break the check that we only contact the
      # expected bridges/guards.
      $vm.execute('systemctl stop tor@default')
    end
  rescue StandardError
    # At least we tried!
  end

  begin
    # If we don't shut down the system under testing it will continue to
    # run during the next scenario's Before hooks, which we have seen
    # causing trouble (for instance, packets from the previous scenario
    # have failed scenarios tagged @check_tor_leaks).
    $vm&.power_off
  rescue StandardError
    # At least we tried!
  end
end
# rubocop:enable Metrics/BlockNesting

Before('@product', '@check_tor_leaks') do |scenario|
  @tor_leaks_sniffer = Sniffer.new(sanitize_filename(scenario.name), $vmnet)
  @tor_leaks_sniffer.capture
  add_after_scenario_hook do
    @tor_leaks_sniffer.clear
  end
end

After('@product', '@check_tor_leaks') do |scenario|
  @tor_leaks_sniffer.stop
  if scenario.passed?
    @allowed_dns_queries ||= []

    allowed_nodes = @bridge_hosts || allowed_hosts_under_tor_enforcement
    allowed_nodes += @extra_allowed_hosts
    debug_log("[check_tor_leaks] Allowed hosts: #{allowed_nodes}")
    debug_log("[check_tor_leaks] Allowed DNS queries: #{@allowed_dns_queries}")
    assert_no_leaks(@tor_leaks_sniffer.pcap_file, allowed_nodes, @allowed_dns_queries)
  end
end

# For @source tests
###################

# BeforeScenario
Before('@source') do
  @orig_pwd = Dir.pwd
  @git_clone = Dir.mktmpdir 'tails-apt-tests'
  Dir.chdir @git_clone
end

# AfterScenario
After('@source') do |scenario|
  Dir.chdir @orig_pwd
  FileUtils.remove_entry_secure @git_clone
  if scenario.failed? && config_bool('INTERACTIVE_DEBUGGING')
    pause(
      "Scenario failed: #{scenario.name}. " \
      "The error was: #{scenario.exception.class.name}: #{scenario.exception}",
      exception: scenario.exception
    )
  end
end
