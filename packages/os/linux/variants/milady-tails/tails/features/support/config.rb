require 'fileutils'
require 'ipaddr'
require 'resolv'
require 'yaml'
require "#{Dir.pwd}/features/support/helpers/misc_helpers.rb"

TRUE_VALUES = ['1', 'y', 'yes', 'true'].freeze
def config_bool(name)
  value = $config[name]

  if value.nil?
    return false
  end

  if value.is_a?(TrueClass) || value.is_a?(FalseClass)
    return value
  end

  # It's not a boolean so we assume it's a string
  TRUE_VALUES.include?(value.downcase)
end

# These files deal with options like some of the settings passed
# to the `run_test_suite` script, and "secrets" like credentials
# (passwords, SSH keys) to be used in tests.
CONFIG_DIR = "#{Dir.pwd}/features/config".freeze
DEFAULTS_CONFIG_FILE = "#{CONFIG_DIR}/defaults.yml".freeze
LOCAL_CONFIG_FILE = "#{CONFIG_DIR}/local.yml".freeze
LOCAL_CONFIG_DIRS_FILES_GLOB = "#{CONFIG_DIR}/*.d/*.yml".freeze

assert File.exist?(DEFAULTS_CONFIG_FILE)
$config = YAML.safe_load(File.read(DEFAULTS_CONFIG_FILE))
config_files = Dir.glob(LOCAL_CONFIG_DIRS_FILES_GLOB).sort
config_files << LOCAL_CONFIG_FILE if File.exist?(LOCAL_CONFIG_FILE)
config_files.each do |config_file|
  yaml_struct = YAML.safe_load(File.read(config_file)) || {}
  unless yaml_struct.instance_of?(Hash)
    raise "Local configuration file '#{config_file}' is malformed"
  end

  $config.merge!(yaml_struct)
end
# Options passed to the `run_test_suite` script will always take
# precedence. The way we import these keys is only safe for values
# with types boolean or string. If we need more, we'll have to invoke
# YAML's type autodetection on ENV some how.
$config.merge!(ENV)

# Export TMPDIR back to the environment for subprocesses that we start
# (e.g. guestfs). Note that this export will only make a difference if
# TMPDIR wasn't already set and --tmpdir wasn't passed, i.e. only when
# we use the default.
ENV['TMPDIR'] = $config['TMPDIR']

# Dynamic constants initialized through the environment or similar,
# e.g. options we do not want to be configurable through the YAML
# configuration files.
DEBUG_LOG_PSEUDO_FIFO = "#{$config['TMPDIR']}/debug_log_pseudo_fifo".freeze
DISPLAY = ENV['DISPLAY']
GIT_DIR = ENV['PWD']
KEEP_CHUTNEY = !ENV['KEEP_CHUTNEY'].nil?
KEEP_SNAPSHOTS = !ENV['KEEP_SNAPSHOTS'].nil?
DISABLE_CHUTNEY = !ENV['DISABLE_CHUTNEY'].nil?
LATE_PATCH = ENV['LATE_PATCH']
EARLY_PATCH = !ENV['EARLY_PATCH'].nil?
EXTRA_BOOT_OPTIONS = ENV['EXTRA_BOOT_OPTIONS']
LIVE_USER = cmd_helper(
  '. config/chroot_local-includes/etc/live/config.d/username.conf; ' \
  'echo ${LIVE_USERNAME}'
).chomp
TAILS_ISO = ENV['TAILS_ISO']
TAILS_IMG = TAILS_ISO.sub(/\.iso/, '.img')
TAILS_BUILD_MANIFEST = TAILS_ISO.sub(/\.iso/, '.build-manifest')
OLD_TAILS_ISO = ENV['OLD_TAILS_ISO'] || TAILS_ISO
OLD_TAILS_IMG = OLD_TAILS_ISO.sub(/\.iso/, '.img')
TIME_AT_START = Time.now
# rubocop:disable Lint/ConstantDefinitionInBlock
# rubocop:disable Style/StringConcatenation
loop do
  ARTIFACTS_DIR = $config['TMPDIR'] + '/run-' +
                  sanitize_filename(TIME_AT_START.to_s) + '-' +
                  [
                    'git',
                    sanitize_filename(describe_git_head,
                                      replacement: '-'),
                    current_short_commit,
                  ].reject(&:empty?).join('_') + '-' +
                  random_alnum_string(6)
  unless File.exist?(ARTIFACTS_DIR)
    FileUtils.mkdir_p(ARTIFACTS_DIR)
    break
  end
end
# rubocop:enable Lint/ConstantDefinitionInBlock
# rubocop:enable Style/StringConcatenation
OPENCV_IMAGE_PATH = "#{Dir.pwd}/features/images/".freeze
OPENCV_MIN_SIMILARITY = 0.9

# Constants that are statically initialized.
LIBVIRT_DOMAIN_NAME = 'TailsToaster'.freeze
LIBVIRT_DOMAIN_UUID = '203552d5-819c-41f3-800e-2c8ef2545404'.freeze
LIBVIRT_NETWORK_NAME = 'TailsToasterNet'.freeze
LIBVIRT_NETWORK_UUID = 'f2305af3-2a64-4f16-afe6-b9dbf02a597e'.freeze
VIRTIO_JOURNAL_DUMPER = 'org.tails.journal_dumper.0'.freeze
VIRTIO_REMOTE_SHELL = 'org.tails.remote_shell.0'.freeze
MISC_FILES_DIR = "#{Dir.pwd}/features/misc_files".freeze
SERVICES_EXPECTED_ON_ALL_IFACES =
  [
    ['cups-browsed', IPAddr.new('0.0.0.0'),    631],
    ['onion-grater', IPAddr.new('0.0.0.0'),    951],
    ['tor',          IPAddr.new('10.200.1.1'), 9050],
  ].freeze
SERVICES_ALLOWED_FOR_LIVE_USER =
  [
    [IPAddr.new('0.0.0.0'),    631],
    [IPAddr.new('0.0.0.0'),    951],
    [IPAddr.new('10.200.1.1'), 9050],
    [IPAddr.new('127.0.0.1'),  5353],
    [IPAddr.new('127.0.0.1'),  631],
    [IPAddr.new('127.0.0.1'),  9062],
    [IPAddr.new('127.0.0.1'),  9040],
    [IPAddr.new('127.0.0.1'),  9050],
  ].freeze
# OpenDNS
SOME_DNS_SERVER = '9.9.9.9'.freeze
RTL_LANGUAGES = ['Arabic', 'Persian'].freeze
VM_XML_PATH = "#{Dir.pwd}/features/domains".freeze
LAN_WEB_SERVER_HELLO_MSG = 'Welcome to the LAN web server!'.freeze

TAILS_SIGNING_KEY = cmd_helper(
  ". #{Dir.pwd}/config/variables; echo ${TAILS_SIGNING_KEY_FP}"
).tr(' ', '').chomp
WEBM_VIDEO_URL = 'https://tails.net/lib/test_suite/test.webm'.freeze

# EFI System Partition
ESP_GUID = 'c12a7328-f81f-11d2-ba4b-00a0c93ec93b'.freeze

LAN_WEB_SERVER_DATA_DIR = "#{$config['TMPDIR']}/lan-web-server".freeze

# Journal entries of priority "err" or higher that we expect to see
# in the system journal.
# rubocop:disable Layout/LineLength
EXPECTED_JOURNAL_ENTRIES = [
  # libpam-gnome-keyring is not installed in Tails
  {
    'SYSLOG_IDENTIFIER' => 'gdm-password]',
    'MESSAGE'           => /PAM unable to dlopen\(pam_gnome_keyring.so\):.*No such file or directory/,
  },
  {
    'SYSLOG_IDENTIFIER' => 'gdm-password]',
    'MESSAGE'           => 'PAM adding faulty module: pam_gnome_keyring.so',
  },
  # gdm-session-worker <= 44.0 tries to unref a NULL object
  # https://gitlab.gnome.org/GNOME/gdm/-/issues/730
  {
    'SYSLOG_IDENTIFIER' => 'gdm-launch-environment]',
    'MESSAGE'           => "GLib-GObject: g_object_unref: assertion 'G_IS_OBJECT (object)' failed",
  },
  # gnome-session tries to put autostart apps into a systemd scope after
  # it started them, which fails if the process already exited.
  # https://gitlab.gnome.org/GNOME/gnome-session/-/issues/120
  {
    'SYSLOG_IDENTIFIER' => 'systemd',
    'MESSAGE'           => /Failed to start app-gnome-.*.scope - Application launched by gnome-session-binary/,
  },
  # The tails-autotest-remote-shell sometimes fails with an I/O error.
  # It's automatically restarted by systemd, so this is not a big deal.
  {
    'SYSLOG_IDENTIFIER' => 'systemd',
    'MESSAGE'           => /Failed to start tails-autotest-remote-shell.service.*/,
  },
  # USBGuard prints this message when it receives an ENOBUFS error when
  # trying to read a pending uevent. This happens sometimes during boot
  # and is not a problem, USBGuard continues to function normally.
  # https://github.com/USBGuard/usbguard/issues/349
  {
    'SYSLOG_IDENTIFIER' => 'usbguard-daemon',
    'MESSAGE'           => /ueventProcessRead: failed to read pending uevent.*/,
  },
  # https://github.com/alsa-project/alsa-lib/issues/90
  {
    'SYSLOG_IDENTIFIER' => 'pulseaudio',
    'MESSAGE'           => /ALSA woke us up to (?:read|write) new data (?:to|from) the device, but there was actually nothing to (?:read|write)\./,
  },
  {
    'SYSLOG_IDENTIFIER' => 'pulseaudio',
    'MESSAGE'           => /Most likely this is a bug in the ALSA driver.*./,
  },
  {
    'SYSLOG_IDENTIFIER' => 'pulseaudio',
    'MESSAGE'           => /We were woken up with (?:POLLIN|POLLOUT) set -- however a subsequent snd_pcm_avail\(\) returned 0 or another value < min_avail\./,
  },
  # The spice client connection is sometimes lost, not clear why.
  {
    'SYSLOG_IDENTIFIER' => 'spice-vdagentd',
    'MESSAGE'           => 'AIIEEE lost spice client connection, reconnecting (err: )',
  },
  {
    'SYSLOG_IDENTIFIER' => 'spice-vdagentd',
    'MESSAGE'           => 'Error receiving data: Connection reset by peer',
  },
  # Fixed in alsa-utils upstream.
  # https://bugs.debian.org/cgi-bin/bugreport.cgi?bug=1093057
  # https://github.com/alsa-project/alsa-utils/issues/280
  {
    'SYSLOG_IDENTIFIER' => 'systemd-udevd',
    'MESSAGE'           => %r{/usr/lib/udev/rules.d/90-alsa-restore.rules:[0-9]+ GOTO="alsa_restore_std" has no matching label, ignoring.},
  },
  # The two following entries about shpchp are ACPI-related failures
  # that started appearing when upgrading TailsToaster to the
  # pc-q35-10.0 machine.
  {
    'SYSLOG_IDENTIFIER' => 'kernel',
    'MESSAGE'           => 'shpchp 0000:01:00.0: pci_hp_register failed with error -16',
  },
  {
    'SYSLOG_IDENTIFIER' => 'kernel',
    'MESSAGE'           => 'shpchp 0000:01:00.0: Slot initialization failed',
  },
].freeze
# rubocop:enable Layout/LineLength

ASP_STATE_DIR = '/run/live-additional-software'.freeze
ASP_CONF = '/live/persistence/TailsData_unlocked/live-additional-software.conf'
           .freeze
