package Test::WebServer;

use strictures 2;
use Carp::Assert;

use parent qw{HTTP::Server::Simple::CGI};

sub new {
    my $class = shift;
    my $args  = shift;
    assert('HASH' eq ref $args);

    my $self = $class->SUPER::new(@_);
    while (my ($k, $v) = each(%{$args})) { $self->{$k} = $v; }
    bless($self, $class);

    return $self;
}

sub print_banner { my $self = shift; 1; }

1;
