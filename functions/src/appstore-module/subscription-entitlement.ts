import {
  NotificationTypeV2,
  Status,
  Subtype,
} from "@apple/app-store-server-library";

export type SubscriptionEntitlement = "active" | "inactive" | "unchanged";

export const resolveSubscriptionEntitlement = (
  notificationType: string | undefined,
  subtype: string | undefined,
  status: number | undefined,
  revocationDate: number | undefined,
): SubscriptionEntitlement => {
  if (revocationDate) {
    return "inactive";
  }

  if (status === Status.ACTIVE || status === Status.BILLING_GRACE_PERIOD) {
    return "active";
  }

  if (
    status === Status.EXPIRED ||
    status === Status.BILLING_RETRY ||
    status === Status.REVOKED
  ) {
    return "inactive";
  }

  switch (notificationType) {
    case NotificationTypeV2.SUBSCRIBED:
    case NotificationTypeV2.DID_RENEW:
    case NotificationTypeV2.OFFER_REDEEMED:
    case NotificationTypeV2.REFUND_REVERSED:
    case NotificationTypeV2.RENEWAL_EXTENDED:
      return "active";
    case NotificationTypeV2.EXPIRED:
    case NotificationTypeV2.GRACE_PERIOD_EXPIRED:
    case NotificationTypeV2.REFUND:
    case NotificationTypeV2.REVOKE:
    case NotificationTypeV2.RESCIND_CONSENT:
      return "inactive";
    case NotificationTypeV2.DID_FAIL_TO_RENEW:
      return subtype === Subtype.GRACE_PERIOD ? "active" : "inactive";
    default:
      return "unchanged";
  }
};
