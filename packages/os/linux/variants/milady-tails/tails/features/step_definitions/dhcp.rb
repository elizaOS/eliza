class DhcpLeakError < StandardError
end

Then /^the hostname should not have been leaked on the network$/ do
  hostnames = ['amnesia', $vm.execute('hostname').stdout.chomp]
  packets = PacketFu::PcapFile.new.file_to_array(filename: @sniffer.pcap_file)
  expected_types = [PacketFu::IPv6Packet, PacketFu::IPPacket,
                    PacketFu::ARPPacket,]
  if packets.any? do |packet|
       type = expected_types.find { |t| t.can_parse?(packet) }
       assert_not_nil(type, 'Found non-IP(v6)/ARP packet')
       payload = type.parse(packet).payload
       hostnames.any? { |hostname| payload.match(hostname) }
     end
    raise DhcpLeakError, 'Hostname leak detected'
  end
rescue DhcpLeakError => e
  save_failure_artifact('Network capture', @sniffer.pcap_file)
  raise e
end
