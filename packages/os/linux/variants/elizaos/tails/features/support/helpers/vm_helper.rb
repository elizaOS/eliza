require 'find'
require 'ipaddr'
require 'libvirt'
require 'rexml/document'

class ExecutionFailedInVM < StandardError
end

class VMNet
  attr_reader :net_name, :net

  def initialize(virt, xml_path)
    @virt = virt
    @net_name = LIBVIRT_NETWORK_NAME
    net_xml = File.read("#{xml_path}/default_net.xml")
    rexml = REXML::Document.new(net_xml)
    rexml.elements['network'].add_element('name')
    rexml.elements['network/name'].text = @net_name
    rexml.elements['network'].add_element('uuid')
    rexml.elements['network/uuid'].text = LIBVIRT_NETWORK_UUID
    update(xml: rexml.to_s)
  rescue StandardError => e
    destroy_and_undefine
    raise e
  end

  # We lookup by name so we also catch networks from previous test
  # suite runs that weren't properly cleaned up (e.g. aborted).
  def destroy_and_undefine
    old_net = @virt.lookup_network_by_name(@net_name)
    old_net.destroy if old_net.active?
    old_net.undefine
  rescue StandardError
    # Nothing to clean up
  end

  def net_xml
    REXML::Document.new(@net.xml_desc)
  end

  def update(xml: nil)
    xml = if block_given?
            xml = net_xml
            # The block modifies the mutable xml (REXML::Document) object
            # as a side-effect.
            yield xml
            xml.to_s
          elsif !xml.nil?
            xml.to_s
          else
            raise 'update needs either XML or a block'
          end
    destroy_and_undefine
    @net = @virt.define_network_xml(xml)
    @net.create
  end

  def bridge_name
    @net.bridge_name
  end

  def bridge_ip_address
    IPAddr.new(net_xml.elements['network/ip[@family="ipv4"]'].attributes['address'])
  end

  def bridge_ipv6_address
    IPAddr.new(net_xml.elements['network/ip[@family="ipv6"]'].attributes['address'])
  end

  def bridge_mac_address
    net_xml.elements['network/mac'].attributes['address']
  end
end

# XXX: giving up on a few worst offenders for now
# rubocop:disable Metrics/ClassLength
class VM
  attr_reader :domain, :domain_name, :display, :vmnet, :storage

  # XXX: giving up on a few worst offenders for now
  # rubocop:disable Metrics/AbcSize
  def initialize(virt, xml_path, vmnet, storage, x_display)
    @virt = virt
    @xml_path = xml_path
    @vmnet = vmnet
    @storage = storage
    @domain_name = LIBVIRT_DOMAIN_NAME
    default_domain_xml = File.read("#{@xml_path}/default.xml")
    rexml = REXML::Document.new(default_domain_xml)
    rexml.elements['domain'].add_element('name')
    rexml.elements['domain/name'].text = @domain_name
    rexml.elements['domain'].add_element('uuid')
    rexml.elements['domain/uuid'].text = LIBVIRT_DOMAIN_UUID

    if $config['LIBVIRT_CPUMODEL']
      rexml.elements['domain/cpu'].add_attribute('mode', 'custom')
      rexml.elements['domain/cpu'].add_attribute('match', 'exact')
      rexml.elements['domain/cpu'].add_attribute('check', 'partial')
      rexml.elements['domain/cpu'].add_element('model')
      rexml.elements['domain/cpu/model'].text = $config['LIBVIRT_CPUMODEL']
      rexml.elements['domain/cpu/model'].add_attribute('fallback', 'allow')
    end

    if config_bool('EARLY_PATCH')
      rexml.elements['domain/devices'].add_element('filesystem')
      rexml.elements['domain/devices/filesystem'].add_attribute('type', 'mount')
      rexml.elements['domain/devices/filesystem'].add_attribute('accessmode',
                                                                'passthrough')
      rexml.elements['domain/devices/filesystem'].add_element('source')
      rexml.elements['domain/devices/filesystem'].add_element('target')
      rexml.elements['domain/devices/filesystem'].add_element('readonly')
      rexml.elements['domain/devices/filesystem/source'].add_attribute('dir', Dir.pwd)
      rexml.elements['domain/devices/filesystem/target'].add_attribute('dir',
                                                                       'tails.git')
    end

    update(xml: rexml.to_s)
    set_vcpu($config['VCPUS']) if $config['VCPUS']
    @display = Display.new(@domain_name, x_display)
    set_cdrom_boot(TAILS_ISO)
    @virtio_channel_sockets = {}
    add_virtio_channel(VIRTIO_JOURNAL_DUMPER)
    add_virtio_channel(VIRTIO_REMOTE_SHELL)
  rescue StandardError => e
    destroy_and_undefine
    raise e
  end
  # rubocop:enable Metrics/AbcSize

  def domain_xml
    REXML::Document.new(@domain.xml_desc)
  end

  def update(xml: nil)
    xml = if block_given?
            xml = domain_xml
            # The block modifies the mutable xml (REXML::Document) object
            # as a side-effect.
            yield xml
            xml.to_s
          elsif !xml.nil?
            xml.to_s
          else
            raise 'update needs either XML or a block'
          end
    destroy_and_undefine
    @domain = @virt.define_domain_xml(xml)
  end

  # We lookup by name so we also catch domains from previous test
  # suite runs that weren't properly cleaned up (e.g. aborted).
  def destroy_and_undefine
    @display.stop if @display&.active?
    begin
      old_domain = @virt.lookup_domain_by_name(@domain_name)
      old_domain.destroy if old_domain.active?
      old_domain.undefine
    rescue StandardError
      # Nothing to clean up
    end
  end

  def real_mac(alias_name)
    domain_xml.elements["domain/devices/interface[@type='network']/" \
                        "alias[@name='#{alias_name}']"]
              .parent.elements['mac'].attributes['address'].to_s
  end

  def all_real_macs
    macs = []
    domain_xml
      .elements.each("domain/devices/interface[@type='network']") do |nic|
      macs << nic.elements['mac'].attributes['address'].to_s
    end
    macs
  end

  def set_hardware_clock(time)
    assert(!running?, 'The hardware clock cannot be set when the ' \
                             'VM is running')
    assert(time.instance_of?(Time), "Argument must be of type 'Time'")
    adjustment = (time - Time.now).to_i
    update do |xml|
      xml.elements['domain']
         .add_element('clock')
         .add_attributes('offset'     => 'variable',
                         'basis'      => 'utc',
                         'adjustment' => adjustment.to_s)
    end
  end

  def network_link_state
    domain_xml.elements['domain/devices/interface/link']
              .attributes['state']
  end

  def set_network_link_state(state)
    new_xml = domain_xml
    new_xml.elements['domain/devices/interface/link']
           .attributes['state'] = state
    if running?
      @domain.update_device(
        new_xml.elements['domain/devices/interface'].to_s
      )
    else
      update(xml: new_xml)
    end
  end

  def plug_network
    set_network_link_state('up')
  end

  def unplug_network
    set_network_link_state('down')
  end

  def add_cdrom_device
    raise "Can't attach a CDROM device to a running domain" if running?

    update do |xml|
      if xml.elements["domain/devices/disk[@device='cdrom']"]
        raise 'A CDROM device already exists'
      end

      cdrom_rexml = REXML::Document.new(
        File.read("#{@xml_path}/cdrom.xml")
      ).root
      xml.elements['domain/devices'].add_element(cdrom_rexml)
    end
  end

  def remove_cdrom_device
    raise "Can't detach a CDROM device to a running domain" if running?

    update do |xml|
      cdrom_el = xml.elements["domain/devices/disk[@device='cdrom']"]
      raise 'No CDROM device is present' if cdrom_el.nil?

      xml.elements['domain/devices'].delete_element(cdrom_el)
    end
  end

  def eject_cdrom
    execute_successfully('/usr/bin/eject -m')
  end

  def remove_cdrom_image
    update do |xml|
      cdrom_el = xml.elements["domain/devices/disk[@device='cdrom']"]
      raise 'No CDROM device is present' if cdrom_el.nil?

      cdrom_el.delete_element('source')
    end
  rescue Libvirt::Error => e
    # While the CD-ROM is removed successfully we still get this
    # error, so let's ignore it.
    acceptable_error =
      'Call to virDomainUpdateDeviceFlags failed: internal error: unable to ' \
      "execute QEMU command 'eject': (Tray of device '.*' is not open|" \
      "Device '.*' is locked)"
    raise e unless Regexp.new(acceptable_error).match(e.to_s)
  end

  def set_cdrom_image(image)
    if image.nil? || (image == '')
      raise "Can't set cdrom image to an empty string"
    end

    remove_cdrom_image
    update do |xml|
      cdrom_el = xml.elements["domain/devices/disk[@device='cdrom']"]
      cdrom_el.add_element('source', { 'file' => image })
    end
  end

  def set_cdrom_boot(image)
    raise 'boot settings can only be set for inactive vms' if running?

    unless domain_xml.elements["domain/devices/disk[@device='cdrom']"]
      add_cdrom_device
    end
    set_cdrom_image(image)

    return if domain_xml.elements["domain/os/boot[@dev='cdrom']"]

    # Set the dev attribute of os/boot to "cdrom"
    update do |xml|
      unless xml.elements['domain/os/boot']
        xml.elements['domain/os'].add_element('boot')
      end
      xml.elements['domain/os/boot'].add_attribute('dev', 'cdrom')
    end
  end

  def list_disk_devs
    ret = []
    domain_xml.elements.each('domain/devices/disk') do |e|
      ret << e.elements['target'].attribute('dev').to_s
    end
    ret
  end

  def plug_device(device_xml)
    if running?
      @domain.attach_device(device_xml.to_s)
    else
      update do |xml|
        xml.elements['domain/devices'].add_element(device_xml)
      end
    end
  end

  # XXX: giving up on a few worst offenders for now
  def plug_drive(name, type)
    raise "disk '#{name}' already plugged" if disk_plugged?(name)

    removable_usb = nil
    case type
    when 'removable usb', 'usb'
      type = 'usb'
      removable_usb = 'on'
    when 'non-removable usb'
      type = 'usb'
      removable_usb = 'off'
    end
    # Get the next free /dev/sdX on guest
    letter = 'a'
    dev = "sd#{letter}"
    while list_disk_devs.include?(dev)
      letter = (letter[0].ord + 1).chr
      dev = "sd#{letter}"
    end
    assert letter <= 'z'

    xml = REXML::Document.new(File.read("#{@xml_path}/disk.xml"))
    xml.elements['disk/source'].attributes['file'] = @storage.disk_path(name)
    xml.elements['disk/driver'].attributes['type'] = @storage.disk_format(name)
    xml.elements['disk/target'].attributes['dev'] = dev
    xml.elements['disk/target'].attributes['bus'] = type
    if removable_usb
      xml.elements['disk/target'].attributes['removable'] = removable_usb
    end

    plug_device(xml)
  end

  def disk_xml_desc(name)
    domain_xml.elements.each('domain/devices/disk') do |e|
      if e.elements['source'].attribute('file').to_s \
         == @storage.disk_path(name)
        return e.to_s
      end
    rescue StandardError
      next
    end
    nil
  end

  def disk_rexml_desc(name)
    xml = disk_xml_desc(name)
    REXML::Document.new(xml) if xml
  end

  def unplug_drive(name)
    xml = disk_xml_desc(name)
    @domain.detach_device(xml)
  end

  def disk_type(dev)
    domain_xml.elements.each('domain/devices/disk') do |e|
      if e.elements['target'].attribute('dev').to_s == dev
        return e.elements['driver'].attribute('type').to_s
      end
    end
    raise "No such disk device '#{dev}'"
  end

  def disk_dev(name)
    (rexml = disk_rexml_desc(name)) || return
    "/dev/#{rexml.elements['disk/target'].attribute('dev')}"
  end

  def disk_name(dev)
    dev = File.basename(dev)
    domain_xml.elements.each('domain/devices/disk') do |e|
      if /^#{e.elements['target'].attribute('dev')}/.match(dev)
        return File.basename(e.elements['source'].attribute('file').to_s)
      end
    end
    raise "No such disk device '#{dev}'"
  end

  def udisks_disk_dev(name)
    disk_dev(name).gsub('/dev/', '/org/freedesktop/UDisks/devices/')
  end

  def disk_detected?(name)
    (dev = disk_dev(name)) || (return false)
    execute("udisksctl info -b #{dev}").success?
  end

  def disk_plugged?(name)
    !disk_xml_desc(name).nil?
  end

  def persistent_storage_dev_on_disk(name)
    "#{disk_dev(name)}2"
  end

  def set_disk_boot(name, type)
    raise 'boot settings can only be set for inactive vms' if running?

    debug_log("Setting boot device to #{name}")

    plug_drive(name, type) unless disk_plugged?(name)

    update do |xml|
      # Remove any os/boot elements
      xml.elements.each('domain/os') do |e|
        e.delete_element('boot')
      end

      # Remove any "boot" element from the disk devices
      xml.elements.each('domain/devices/disk') do |e|
        e.delete_element('boot')
      end

      # Add a "boot" element with the "order" attribute set to 1 to the
      # disk device which has source file set to the given name.
      found_device = false
      xml.elements.each("domain/devices/disk[@device='disk']") do |e|
        source_file = e.elements['source'].attribute('file').to_s
        next unless source_file == @storage.disk_path(name)

        e.add_element('boot', { 'order' => '1' })
        found_device = true
        break
      end
      raise "No such disk device '#{name}'" unless found_device
    end
  end

  def set_os_loader(type)
    raise 'boot settings can only be set for inactive vms' if running?
    raise 'unsupported OS loader type' unless type == 'UEFI'

    update do |xml|
      # In recent versions of Libvirt the old way we configured UEFI
      # boot breaks when AppArmor is enabled (tails#20549) but the
      # alternative way that works with AppArmor causes issues with
      # UEFI booting (at least on Jenkins, see tails#20681).
      libvirt_version = cmd_helper(
        "dpkg-query --show --showformat='${source:Upstream-Version}' libvirt0"
      )
      if Gem::Version.new(libvirt_version) < Gem::Version.new(10)
        xml.elements['domain/os'].add_element(
          REXML::Document.new('<loader>/usr/share/ovmf/OVMF.fd</loader>')
        )
      else
        xml.elements['domain/os'].add_attribute('firmware', 'efi')
        xml.elements['domain/os'].add_element('loader', { 'secure' => 'yes' })
      end
    end
  end

  def running?
    @domain.active?
  rescue StandardError
    false
  end

  def execute(cmd, **options)
    options[:user] ||= 'root'
    options[:spawn] = false unless options.key?(:spawn)
    if options[:libs]
      libs = options[:libs]
      options.delete(:libs)
      libs = [libs] unless libs.methods.include? :map
      cmds = libs.map do |lib_name|
        ". /usr/local/lib/tails-shell-library/#{lib_name}.sh"
      end
      cmds << cmd
      cmd = cmds.join(' && ')
    end
    RemoteShell::ShellCommand.new(self, cmd, **options)
  end

  def execute_successfully(*args, **options)
    assert(!options[:spawn], 'Spawned commands provide no feedback about success. ' \
                             'Just use spawn() instead!')
    p = execute(*args, **options)
    begin
      assert_vmcommand_success(p)
    rescue Test::Unit::AssertionFailedError => e
      raise ExecutionFailedInVM, e
    end
    p
  end

  def spawn(cmd, **options)
    options[:spawn] = true
    execute(cmd, **options)
  end

  def virtio_channel_socket_path(channel)
    domain_rexml = REXML::Document.new(@domain.xml_desc)
    domain_rexml.elements.each('domain/devices/channel') do |e|
      target = e.elements['target']
      if target.attribute('name').to_s == channel
        return e.elements['source'].attribute('path').to_s
      end
    end
    raise "There is no #{channel} virtio channel"
  end

  def add_virtio_channel(channel)
    if running?
      raise 'Virtio channels can only be added to inactive vms'
    end

    @virtio_channel_sockets[channel] ||=
      "/tmp/virtio-channel_#{random_alnum_string(8)}.socket"
    update do |xml|
      channel_xml = <<-XML
        <channel type='unix'>
          <source mode="bind" path='#{@virtio_channel_sockets[channel]}'/>
          <target type='virtio' name='#{channel}'/>
        </channel>
      XML
      xml.elements['domain/devices'].add_element(
        REXML::Document.new(channel_xml)
      )
    end
  end

  def remote_shell_is_up?
    msg = 'hello?'
    Timeout.timeout(3) do
      execute_successfully("echo '#{msg}'").stdout.chomp == msg
    end
  rescue StandardError
    debug_log('The remote shell failed to respond within 3 seconds')
    false
  end

  def wait_until_remote_shell_is_up(timeout = 90)
    try_for(timeout, msg: 'Remote shell seems to be down') do
      remote_shell_is_up?
    end
  end

  def host_to_guest_time_sync
    host_time = Time.now.utc.strftime('%F %T')
    execute_successfully("timedatectl set-time '#{host_time}'")
  end

  def ip_address(version: 4)
    nmcli_info = $vm.execute_successfully('nmcli device show eth0').stdout
    addrs = nmcli_info.scan(%r{^IP#{version}.ADDRESS(?:\[\d+\])?:\s*(.+)/\d+$})
                      .flatten.map { |addr| IPAddr.new(addr) }
    if addrs.size > 1
      raise "The default network interface has more than one IPv#{version} address, " \
            "which isn't supported"
    elsif addrs.size == 1
      return addrs.first
    end

    nil
  end

  def ipv6_address
    ip_address(version: 6)
  end

  def connected_to_network?
    network_link_state == 'up' && ip_address
  end

  def process_running?(process)
    execute("pidof -x -o '%PPID' #{process}").success?
  end

  def pidof(process)
    execute("pidof -x -o '%PPID' #{process}").stdout.chomp.split
  end

  def file_exist?(file)
    execute("test -e '#{file}'").success?
  end

  def file_empty?(file)
    execute("test -s '#{file}'").failure?
  end

  def directory_exist?(directory)
    execute("test -d '#{directory}'").success?
  end

  def file_glob(expr)
    execute(
      <<-COMMAND
        bash -c '
          shopt -s globstar dotglob nullglob
          set -- #{expr}
          while [ -n "${1}" ]; do
            echo -n "${1}"
            echo -ne "\\0"
            shift
          done'
      COMMAND
    ).stdout.chomp.split("\0")
  end

  def file_open(path, **opts)
    f = RemoteShell::File.new(self, path, **opts)
    yield f if block_given?
    f
  end

  def file_content(paths)
    paths = [paths] unless paths.instance_of?(Array)
    paths.reduce('') do |acc, path|
      acc + file_open(path).read
    end
  end

  def file_overwrite(path, lines, permissions: nil)
    lines = lines.join("\n") if lines.instance_of?(Array)
    file_open(path) { |f| f.write(lines) }
    unless permissions.nil?
      execute_successfully("chmod #{permissions} '#{path}'")
    end
  end

  def file_copy_local(localpath, vm_path)
    debug_log("copying #{localpath} to #{vm_path}")
    content = File.read(localpath)
    permissions = File.stat(localpath).mode.to_s(8)[-3..]
    file_overwrite(vm_path, content, permissions:)
  end

  def file_copy_local_dir(localdir, vm_dir)
    localfiles = Dir.chdir(localdir) { Find.find('.').select { |p| FileTest.file?(p) } }
    localfiles.each do |fpath|
      # fpath is, for example,"./etc/amnesia/version"
      vm_path = fpath[1..]
      dir = File.dirname(vm_path)

      execute_successfully("mkdir -p '#{File.join(vm_dir, dir)}'")
      file_copy_local(File.join(localdir, fpath), File.join(vm_dir, vm_path))
    end
  end

  def patch_l10n
    tempfile = "#{$config['TMPDIR']}/patch.mo"
    Dir['po/*.po'].each do |po|
      language = File.basename(po, '.po')
      cmd_helper(['msgfmt', '--check', '-o', tempfile, po])
      vm_mo = "/usr/share/locale/#{language}/LC_MESSAGES/tails.mo"
      $vm.file_copy_local(tempfile, vm_mo)
      File.unlink(tempfile)
    end
  end

  # rubocop:disable Metrics/AbcSize
  # rubocop:disable Metrics/CyclomaticComplexity
  # rubocop:disable Metrics/MethodLength
  # rubocop:disable Metrics/PerceivedComplexity
  def late_patch(fname: $config['LATE_PATCH'])
    include_dir = File.join('config', 'chroot_local-includes')
    if fname.nil? || fname.empty?
      commit = $vm.execute_successfully(
        '. /etc/os-release; echo "${TAILS_GIT_COMMIT}"'
      ).stdout.chomp
      if commit.empty?
        # When testing the testoverlayfs IUKs /etc/os-release is
        # overwritten with a simplified version that doesn't contain
        # TAILS_GIT_COMMIT, so we recover it from the originally
        # installed filesystem.squashfs.
        commit = $vm.execute_successfully(
          '. /lib/live/mount/rootfs/filesystem.squashfs/etc/os-release; ' \
          'echo "${TAILS_GIT_COMMIT}"'
        ).stdout.chomp
      end
      debug_log("late-patch: patching all changed files since build commit #{commit}")
      modified = cmd_helper(['git', 'diff', commit, '--name-only', '--',
                             include_dir,]).chomp.split("\n")
      untracked = cmd_helper(['git', 'ls-files', '--others', '--exclude-standard',
                              '--', include_dir,]).chomp.split("\n")
      files_to_copy = modified + untracked
    else
      files_to_copy = File.open(fname).map do |line|
        next if line.start_with?('#') || line.empty?

        line.chomp.split("\t", 2)
      end
    end

    files_to_copy.each do |src_dest|
      src, dest = src_dest
      if dest.nil?
        if src.start_with?(include_dir)
          dest = src.delete_prefix(include_dir)
        else
          candidate_src = File.join(include_dir, src)
          if File.exist?(candidate_src)
            src = candidate_src
            dest = src
          else
            debug_log("Error in --late-patch: not sure what to do with line: #{line}")
          end
        end
      end
      unless File.exist?(src)
        debug_log("Error in --late-patch: #{src} does not exist")
        next
      end
      if File.file?(src)
        $vm.file_copy_local(src, dest)
      elsif File.directory?(src)
        $vm.file_copy_local_dir(src, dest)
      else
        debug_log("Error in --late-patch: #{src} not a file or a dir")
      end
    end

    patch_l10n
  end
  # rubocop:enable Metrics/AbcSize
  # rubocop:enable Metrics/MethodLength
  # rubocop:enable Metrics/PerceivedComplexity
  # rubocop:enable Metrics/CyclomaticComplexity

  def file_append(path, lines)
    lines = lines.join("\n") if lines.instance_of?(Array)
    file_open(path) { |f| return f.append(lines) }
  end

  def set_clipboard(text)
    execute_successfully("echo -n '#{text}' | xsel --input --clipboard",
                         user: LIVE_USER)
    try_for(5) do
      get_clipboard == text
    end
  end

  def get_clipboard
    execute_successfully('xsel --output --clipboard', user: LIVE_USER).stdout
  end

  def internal_snapshot_xml(name)
    disk_devs = list_disk_devs
    disks_xml = "    <disks>\n"
    disk_devs.each do |dev|
      snapshot_type = disk_type(dev) == 'qcow2' ? 'internal' : 'no'
      disks_xml +=
        "      <disk name='#{dev}' snapshot='#{snapshot_type}'></disk>\n"
    end
    disks_xml += '    </disks>'
    <<~XML
      <domainsnapshot>
        <name>#{name}</name>
        <description>Snapshot for #{name}</description>
      #{disks_xml}
        </domainsnapshot>
    XML
  end

  def self.ram_only_snapshot_path(name)
    "#{$config['TMPDIR']}/#{name}-snapshot.memstate"
  end

  def save_internal_snapshot(name)
    xml = internal_snapshot_xml(name)
    @domain.snapshot_create_xml(xml)
  end

  def save_ram_only_snapshot(name)
    snapshot_path = VM.ram_only_snapshot_path(name)
    begin
      @domain.save(snapshot_path)
    rescue Guestfs::Error => e
      no_space_left_error =
        'Call to virDomainSaveFlags failed: operation failed: ' \
        '/usr/lib/libvirt/libvirt_iohelper: failure with .*: ' \
        'Unable to write .*: No space left on device'
      if Regexp.new(no_space_left_error).match(e.to_s)
        cmd = "du -ah \"#{$config['TMPDIR']}\" | sort -hr | head -n20"
        info_log("Output of \"#{cmd}\":\n" + `#{cmd}`)
        raise NoSpaceLeftError.New(e)
      else
        info_log('saving snapshot failed but was not a no-space-left error')
        raise e
      end
    end
  end

  def save_snapshot(name)
    debug_log("Saving snapshot '#{name}'...")
    JournalDumper.instance.stop
    # If we have no qcow2 disk device, we'll use "memory state"
    # snapshots, and if we have at least one qcow2 disk device, we'll
    # use internal "system checkpoint" (memory + disks) snapshots. We
    # have to do this since internal snapshots don't work when no
    # such disk is available. We can do this with external snapshots,
    # which are better in many ways, but libvirt doesn't know how to
    # restore (revert back to) them yet.
    # WARNING: If only transient disks, i.e. disks that were plugged
    # after starting the domain, are used then the memory state will
    # be dropped. External snapshots would also fix this.
    internal_snapshot = false
    domain_xml.elements.each('domain/devices/disk') do |e|
      if e.elements['driver'].attribute('type').to_s == 'qcow2'
        internal_snapshot = true
        break
      end
    end

    # NOTE: In this case the "opposite" of `internal_snapshot` is not
    # anything relating to external snapshots, but actually "memory
    # state"(-only) snapshots.
    if internal_snapshot
      save_internal_snapshot(name)
      # In the non-internal snapshot case we also restore the
      # snapshot, which also restarts JournalDumper, so we don't have
      # to start it again in the other case like we do here.
      JournalDumper.instance.start
    else
      save_ram_only_snapshot(name)
      # For consistency with the internal snapshot case (which is
      # "live", so the domain doesn't go down) we immediately restore
      # the snapshot.
      # Assumption: that *immediate* save + restore doesn't mess up
      # with network state and similar, and is fast enough to not make
      # the clock drift too much.
      restore_snapshot(name)
    end
  end

  def restore_snapshot(name)
    debug_log("Restoring snapshot '#{name}'...")
    @domain.destroy if running?
    @display.stop if @display&.active?
    # See comment in save_snapshot() for details on why we use two
    # different type of snapshots.
    potential_ram_only_snapshot_path = VM.ram_only_snapshot_path(name)
    if File.exist?(potential_ram_only_snapshot_path)
      Libvirt::Domain.restore(@virt, potential_ram_only_snapshot_path)
      @domain = @virt.lookup_domain_by_name(@domain_name)
    else
      begin
        potential_internal_snapshot = @domain.lookup_snapshot_by_name(name)
        @domain.revert_to_snapshot(potential_internal_snapshot)
      rescue Guestfs::Error, Libvirt::RetrieveError => e
        raise "The (internal nor external) snapshot #{name} may be known " \
              'by libvirt but it cannot be restored. ' \
              "To investigate, use 'virsh snapshot-list TailsToaster'. " \
              "To clean up old dangling snapshots, use 'virsh snapshot-delete'.\n" \
              "Error: #{e}"
      end
    end
    JournalDumper.instance.start
    @display.start
  end

  def self.remove_snapshot(name)
    old_domain = $virt.lookup_domain_by_name(LIBVIRT_DOMAIN_NAME)
    potential_ram_only_snapshot_path = VM.ram_only_snapshot_path(name)
    if File.exist?(potential_ram_only_snapshot_path)
      File.delete(potential_ram_only_snapshot_path)
    else
      snapshot = old_domain.lookup_snapshot_by_name(name)
      snapshot.delete
    end
  end

  def self.snapshot_exists?(name)
    return true if File.exist?(VM.ram_only_snapshot_path(name))

    old_domain = $virt.lookup_domain_by_name(LIBVIRT_DOMAIN_NAME)
    snapshot = old_domain.lookup_snapshot_by_name(name)
    !snapshot.nil?
  rescue Libvirt::RetrieveError
    false
  end

  def self.remove_all_snapshots
    Dir.glob("#{$config['TMPDIR']}/*-snapshot.memstate").each do |file|
      File.delete(file)
    end
    old_domain = $virt.lookup_domain_by_name(LIBVIRT_DOMAIN_NAME)
    old_domain.list_all_snapshots.each(&:delete)
  rescue Libvirt::RetrieveError
    # No such domain, so no snapshots either.
  end

  def start
    return if running?

    @domain.create
    @display.start
  end

  def reset
    @domain.reset if running?
  end

  def power_off
    begin
      @domain.destroy if running?
    # We're sometimes running this code while Tails is shutting down (#18972),
    # in which case the above statement is racy (TOCTOU). So we ignore
    # the resulting failures:
    rescue Guestfs::Error => e
      raise e unless Regexp.new('Call to virDomainDestroy(Flags)? failed: ' \
                                'Requested operation is not valid: ' \
                                'domain is not running')
                           .match?(e.to_s)

      debug_log('Tried to destroy a domain that was already stopped, ignoring')
    end
    @display.stop
  end

  def set_vcpu(nr_cpus)
    raise 'Cannot set the number of CPUs for a running domain' if running?

    update { |xml| xml.elements['domain/vcpu'].text = nr_cpus }
  end
end
# rubocop:enable Metrics/ClassLength
