=head1 NAME

Tails::IUK::Role::FormatByte - role for format a byte count

=cut

package Tails::IUK::Role::FormatByte;

use 5.10.1;
use strictures 2;
use autodie qw(:all);

use Function::Parameters;
use Number::Format;
use Types::Standard qw(InstanceOf Num);

use Moo::Role;

use Locale::TextDomain 'tails';

use namespace::clean;

has 'number_formatter' => (
    is  => 'ro',
    is  =>  'lazy',
    isa =>  InstanceOf['Number::Format'],
);

method _build_number_formatter () {
    Number::Format->new(
        #Translators: KB is the short form for kilobyte
        kilo_suffix => __(q{KB}),
        #Translators: MB is the short form for megabyte
        mega_suffix => __(q{MB}),
        #Translators: GB is the short form for gigabyte
        giga_suffix => __(q{GB}),
    );
}

# Convert a number of bytes to human readable format
method format_bytes (Num $number) {
    return int($number) .  __(q{bytes})
        if $number < 1024;
    $self->number_formatter->format_bytes(
        $number,
        precision => 0,
    );
}

no Moo::Role;
1;
