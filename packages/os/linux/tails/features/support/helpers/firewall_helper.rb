require 'packetfu'
require 'net/dns'

# Unfortunately PacketFu's ICMPv6 module does not support the embedded
# MLDv2 protocol, which is used during SLAAC.
def looks_like_mldv2_packet?(packet)
  # Multicast Listener Report Message v2
  packet.instance_of?(PacketFu::IPv6Packet) &&
    # IPv6 type: ICMPv6.
    packet.payload[0].ord == 58 &&
    # ICMPv6 type: MLDv2.
    packet.payload[8].ord == 143 &&
    # IPv6 multicast to MLDv2-capable routers.
    IPAddr.new(packet.ipv6_daddr) == IPAddr.new('ff02::16') &&
    # Corresponding ethernet multicast address.
    packet.eth_daddr == '33:33:00:00:00:16'
end

# rubocop:disable Metrics/AbcSize
def looks_like_slaac_packet?(packet)
  return true if looks_like_mldv2_packet?(packet)

  return false unless packet.instance_of?(PacketFu::ICMPv6Packet)

  case packet.ipv6_header.body.icmpv6_type
  # Router solicitation
  when 133
    IPAddr.new(packet.ipv6_saddr) == $vm.ipv6_address &&
      # IPv6 multicast to all local routers
      IPAddr.new(packet.ipv6_daddr) == IPAddr.new('ff02::2')
  # Neighbor solicitation
  when 135
    (
      IPAddr.new(packet.ipv6_saddr) == $vm.ipv6_address &&
      IPAddr.new(packet.ipv6_daddr) == $vmnet.bridge_ipv6_address
    ) ||
      # Special case: Duplicate Address Detection (DAD)
      (
        # The lowest 24 bits of the IPv6 address are used to create
        # the multicast addresses for DAD. We must pad with leading
        # zeros up to the full 24 bits (so 6 hex chars) since the
        # first part is inserted into the middle of a IPv6 address
        # group, and zeros can only (optionally) be omitted when
        # occurring in the beginning of a group.
        low = ($vm.ipv6_address & 0xffffff).to_i.to_s(16).rjust(6, '0')
        # Solicited-node multicast address used for checking if the
        # address is already in use
        dad_ipv6_addr = IPAddr.new("ff02::1:ff#{low[0, 2]}:#{low[2, 4]}")
        # Corresponding ethernet multicast address
        dad_eth_addr = "33:33:ff:#{low[0, 2]}:#{low[2, 2]}:#{low[4, 2]}"

        IPAddr.new(packet.ipv6_saddr) == IPAddr.new('::') &&
        IPAddr.new(packet.ipv6_daddr) == dad_ipv6_addr &&
        packet.eth_daddr == dad_eth_addr
      )
  # Neighbor advertisement
  when 136
    IPAddr.new(packet.ipv6_saddr) == $vm.ipv6_address &&
      IPAddr.new(packet.ipv6_daddr) == $vmnet.bridge_ipv6_address
  else
    false
  end
end
# rubocop:enable Metrics/AbcSize

def looks_like_dhcp_packet?(packet)
  packet.instance_of?(PacketFu::UDPPacket) &&
    packet.udp_sport == 68 &&
    packet.udp_dport == 67 &&
    packet.eth_daddr == 'ff:ff:ff:ff:ff:ff' &&
    packet.ip_daddr == '255.255.255.255'
end

def rarp_packet?(pcap_packet)
  # Details: https://www.netometer.com/qa/rarp.html#A13
  pcap_packet.force_encoding('UTF-8').start_with?(
    "\xFF\xFF\xFF\xFF\xFF\xFFRT\x00\xAC\xDD\xEE\x805\x00\x01\b\x00\x06"
  ) && (pcap_packet[19] == "\x03" || pcap_packet[19] == "\x04")
end

def connection_info(packet)
  connection = {
    mac_saddr: packet.eth_saddr,
    mac_daddr: packet.eth_daddr,
    protocol:  (packet.proto - ['Eth']).join('::'),
    saddr:     nil,
    daddr:     nil,
  }

  begin
    connection[:saddr] = packet.ip_saddr
    connection[:daddr] = packet.ip_daddr
  rescue NameError
    begin
      connection[:saddr] = packet.ipv6_saddr
      connection[:daddr] = packet.ipv6_daddr
    rescue NameError
      puts "We were hit by #11508. PacketFu bug? Packet info:\n#{packet}"
    end
  end

  case packet
  when PacketFu::TCPPacket
    connection[:sport] = packet.tcp_sport
    connection[:dport] = packet.tcp_dport
  when PacketFu::UDPPacket
    connection[:sport] = packet.udp_sport
    connection[:dport] = packet.udp_dport
    if packet.udp_dport == 53
      begin
        dns_packet = Net::DNS::Packet.parse(packet.payload)
      rescue ArgumentError
        dns_packet = nil
      end
      unless dns_packet.nil? || dns_packet.question.empty?
        connection[:dns_question] = dns_packet.question.map(&:qName)
      end
    end
  end

  connection
end

# Returns the unique edges (based on protocol, source/destination
# address/port) in the graph of all network flows.
def pcap_connections_helper(pcap_file,
                            ignore_arp: true,
                            ignore_dhcp: true,
                            ignore_slaac: true,
                            ignore_sources: [$vm.vmnet.bridge_mac_address])
  connections = []
  PacketFu::PcapFile.new.file_to_array(filename: pcap_file).map do |pcap_packet|
    # PacketFu cannot parse RARP, see #16825. We consider RARP safe.
    next if rarp_packet?(pcap_packet)

    packet = PacketFu::Packet.parse(pcap_packet)
    if packet.instance_of?(PacketFu::InvalidPacket)
      raise FirewallAssertionFailedError,
            'Found something PacketFu cannot parse'
    end

    next if ignore_arp && packet.instance_of?(PacketFu::ARPPacket)
    next if ignore_dhcp && looks_like_dhcp_packet?(packet)
    next if ignore_slaac && looks_like_slaac_packet?(packet)
    next if ignore_sources.include?(packet.eth_saddr)

    connections << connection_info(packet)
  end
  connections.uniq.map { |p| OpenStruct.new(p) }
end

class FirewallAssertionFailedError < Test::Unit::AssertionFailedError
end

# These assertions are made from the perspective of the system under
# testing when it comes to the concepts of "source" and "destination".
def assert_all_connections(pcap_file,
                           message: 'Unexpected connections were made',
                           **opts, &block)
  all = pcap_connections_helper(pcap_file, **opts)
  good = all.select(&block)
  bad = all - good
  return if bad.empty?

  raise FirewallAssertionFailedError,
        "#{message}\n" +
        bad.map { |e| "  #{e}" }.join("\n")
end

def assert_no_connections(pcap_file, **opts, &block)
  assert_all_connections(pcap_file, **opts) { |*args| !block.call(*args) }
end

def assert_no_leaks(pcap_file, allowed_hosts, allowed_dns_queries, **opts)
  assert_all_connections(pcap_file, **opts) do |c|
    allowed_hosts.include?({ address: c.daddr, port: c.dport })
  end

  # yes, we could combine these two checks in a single one,
  # and that would probably be more efficient.
  # However, we're gaining something when it comes to debugging:
  # the line number now tells you *which* check  has failed
  dns_opts = opts.clone
  dns_opts[:message] = 'Unexpected DNS queries were made'
  assert_all_connections(pcap_file, **dns_opts) do |c|
    !defined?(c.dns_question) ||
      c.dns_question.all? { |q| allowed_dns_queries.include?(q) }
  end
end

def debug_useless_dns_exceptions(pcap_file, allowed_dns_queries)
  queries_made = Set.new
  pcap_connections_helper(pcap_file) do |c|
    next unless defined?(c.dns_question)

    queries_made += c.dns_question
  end
  queries_allowed = Set.new(allowed_dns_queries)
  useless_dns_exceptions = queries_allowed - queries_made
  return if useless_dns_exceptions.empty?

  info_log(
    'Warning: these queries were allowed but not needed: ' \
    "#{useless_dns_exceptions.to_a}"
  )
end
