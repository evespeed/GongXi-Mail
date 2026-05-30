import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Table,
    Button,
    Space,
    Modal,
    Form,
    Input,
    Select,
    message,
    Popconfirm,
    Tag,
    Typography,
    Upload,
    Tooltip,
    List,
    Tabs,
    Spin,
    Pagination,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
    PlusOutlined,
    EditOutlined,
    DeleteOutlined,
    UploadOutlined,
    DownloadOutlined,
    InboxOutlined,
    SearchOutlined,
    MailOutlined,
    GroupOutlined,
    SyncOutlined,
    CheckCircleOutlined,
    CopyOutlined,
} from '@ant-design/icons';
import { emailApi, groupApi } from '../../api';
import { getErrorMessage } from '../../utils/error';
import { requestData } from '../../utils/request';
import dayjs from 'dayjs';

const { Title, Text } = Typography;
const { TextArea } = Input;
const { Dragger } = Upload;
const MAIL_FETCH_STRATEGY_OPTIONS = [
    { value: 'IMAP_FIRST', label: 'IMAP 优先（失败回退 Graph）' },
    { value: 'GRAPH_FIRST', label: 'Graph 优先（失败回退 IMAP）' },
    { value: 'GRAPH_ONLY', label: '仅 Graph' },
    { value: 'IMAP_ONLY', label: '仅 IMAP' },
] as const;

type MailFetchStrategy = (typeof MAIL_FETCH_STRATEGY_OPTIONS)[number]['value'];

const MAIL_FETCH_STRATEGY_LABELS: Record<MailFetchStrategy, string> = {
    GRAPH_FIRST: 'Graph 优先',
    IMAP_FIRST: 'IMAP 优先',
    GRAPH_ONLY: '仅 Graph',
    IMAP_ONLY: '仅 IMAP',
};

const UNGROUPED_FILTER_VALUE = '__ungrouped__' as const;
type GroupFilterValue = number | typeof UNGROUPED_FILTER_VALUE;

interface EmailGroup {
    id: number;
    name: string;
    description: string | null;
    fetchStrategy: MailFetchStrategy;
    emailCount: number;
    createdAt: string;
    updatedAt: string;
}

interface EmailAccount {
    id: number;
    email: string;
    clientId: string;
    status: 'ACTIVE' | 'ERROR' | 'DISABLED';
    groupId: number | null;
    group: { id: number; name: string } | null;
    lastCheckAt: string | null;
    tokenRefreshedAt: string | null;
    lastVerificationCode: string | null;
    lastVerificationMailAt: string | null;
    lastVerificationCheckedAt: string | null;
    errorMessage: string | null;
    createdAt: string;
}

interface EmailListResult {
    list: EmailAccount[];
    total: number;
}

interface MailItem {
    id: number;
    mailbox: string;
    providerMessageId: string;
    from: string | null;
    subject: string | null;
    bodyPreview: string | null;
    sentAt: string | null;
    receivedAt: string | null;
    firstFetchedAt: string;
    lastFetchedAt: string;
    isNew: boolean;
}

interface MailListResult {
    mailbox: string;
    page: number;
    pageSize: number;
    total: number;
    messages: MailItem[];
}

interface MailDetail extends MailItem {
    text: string | null;
    html: string | null;
}

interface EmailDetailsResult extends EmailAccount {
    refreshToken: string;
}

const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

const renderPlainTextEmail = (value: string): string =>
    `<pre style="white-space: pre-wrap; word-break: break-word; margin: 0;">${escapeHtml(value)}</pre>`;

const getSelectedGroupIds = (values: GroupFilterValue[]): number[] =>
    values.filter((value): value is number => typeof value === 'number');

const copyTextToClipboard = async (text: string) => {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
};

const EmailsPage: React.FC = () => {
    const [loading, setLoading] = useState(false);
    const [data, setData] = useState<EmailAccount[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
    const [modalVisible, setModalVisible] = useState(false);
    const [importModalVisible, setImportModalVisible] = useState(false);
    const [mailModalVisible, setMailModalVisible] = useState(false);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [keyword, setKeyword] = useState('');
    const [debouncedKeyword, setDebouncedKeyword] = useState('');
    const [filterGroupValues, setFilterGroupValues] = useState<GroupFilterValue[]>([UNGROUPED_FILTER_VALUE]);
    const [importContent, setImportContent] = useState('');
    const [separator, setSeparator] = useState('----');
    const [importGroupId, setImportGroupId] = useState<number | undefined>(undefined);
    const [mailList, setMailList] = useState<MailItem[]>([]);
    const [mailTotal, setMailTotal] = useState(0);
    const [mailPage, setMailPage] = useState(1);
    const [mailPageSize, setMailPageSize] = useState(10);
    const [mailLoading, setMailLoading] = useState(false);
    const mailLoadingRef = useRef(false);
    const [currentEmail, setCurrentEmail] = useState<string>('');
    const [currentEmailId, setCurrentEmailId] = useState<number | null>(null);
    const [currentEmailGroupValue, setCurrentEmailGroupValue] = useState<GroupFilterValue>(UNGROUPED_FILTER_VALUE);
    const [currentMailbox, setCurrentMailbox] = useState<string>('INBOX');
    const [mailGroupUpdating, setMailGroupUpdating] = useState(false);
    const [emailDetailVisible, setEmailDetailVisible] = useState(false);
    const [emailDetailContent, setEmailDetailContent] = useState<string>('');
    const [emailDetailSubject, setEmailDetailSubject] = useState<string>('');
    const [emailDetailLoading, setEmailDetailLoading] = useState(false);
    const [emailEditLoading, setEmailEditLoading] = useState(false);
    const [form] = Form.useForm();

    // Group-related state
    const [groups, setGroups] = useState<EmailGroup[]>([]);
    const [groupModalVisible, setGroupModalVisible] = useState(false);
    const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
    const [groupForm] = Form.useForm();
    const [assignGroupModalVisible, setAssignGroupModalVisible] = useState(false);
    const [assignTargetGroupId, setAssignTargetGroupId] = useState<number | undefined>(undefined);
    const [refreshingTokenIds, setRefreshingTokenIds] = useState<Set<number>>(new Set());
    const [checkingEmailIds, setCheckingEmailIds] = useState<Set<number>>(new Set());
    const [batchRefreshing, setBatchRefreshing] = useState(false);
    const latestListRequestIdRef = useRef(0);

    const toOptionalNumber = (value: unknown): number | undefined => {
        if (value === undefined || value === null || value === '') {
            return undefined;
        }
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    };

    const fetchGroups = useCallback(async () => {
        const result = await requestData<EmailGroup[]>(
            () => groupApi.getList(),
            '获取分组失败',
            { silent: true }
        );
        if (result) {
            setGroups(result);
        }
    }, []);

    const fetchData = useCallback(async () => {
        const currentRequestId = ++latestListRequestIdRef.current;
        setLoading(true);
        const selectedGroupIds = getSelectedGroupIds(filterGroupValues);
        const params: {
            page: number;
            pageSize: number;
            keyword: string;
            groupIds?: string;
            includeUngrouped?: boolean;
        } = { page, pageSize, keyword: debouncedKeyword };
        if (selectedGroupIds.length > 0) params.groupIds = selectedGroupIds.join(',');
        if (filterGroupValues.includes(UNGROUPED_FILTER_VALUE)) params.includeUngrouped = true;

        const result = await requestData<EmailListResult>(
            () => emailApi.getList(params),
            '获取数据失败'
        );
        if (currentRequestId !== latestListRequestIdRef.current) {
            return;
        }
        if (result) {
            setData(result.list);
            setTotal(result.total);
        }
        setLoading(false);
    }, [debouncedKeyword, filterGroupValues, page, pageSize]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            void fetchGroups();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [fetchGroups]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            setDebouncedKeyword(keyword.trim());
        }, 300);
        return () => window.clearTimeout(timer);
    }, [keyword]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            void fetchData();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [fetchData]);

    const handleCreate = () => {
        setEditingId(null);
        setEmailEditLoading(false);
        form.resetFields();
        setModalVisible(true);
    };

    const handleEdit = useCallback(async (record: EmailAccount) => {
        setEditingId(record.id);
        setEmailEditLoading(true);
        form.resetFields();
        setModalVisible(true);
        try {
            const res = await emailApi.getById<EmailDetailsResult>(record.id, true);
            if (res.code === 200) {
                const details = res.data;
                form.setFieldsValue({
                    email: details.email,
                    clientId: details.clientId,
                    refreshToken: details.refreshToken,
                    status: details.status,
                    groupId: details.groupId,
                });
            }
        } catch {
            message.error('获取详情失败');
        } finally {
            setEmailEditLoading(false);
        }
    }, [form]);

    const handleDelete = useCallback(async (id: number) => {
        try {
            const res = await emailApi.delete(id);
            if (res.code === 200) {
                message.success('删除成功');
                fetchData();
                fetchGroups();
            } else {
                message.error(res.message);
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '删除失败'));
        }
    }, [fetchData, fetchGroups]);

    const handleBatchDelete = async () => {
        if (selectedRowKeys.length === 0) {
            message.warning('请选择要删除的邮箱');
            return;
        }

        try {
            const res = await emailApi.batchDelete(selectedRowKeys as number[]);
            if (res.code === 200) {
                message.success(`成功删除 ${res.data.deleted} 个邮箱`);
                setSelectedRowKeys([]);
                fetchData();
                fetchGroups();
            } else {
                message.error(res.message);
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '删除失败'));
        }
    };

    const handleSubmit = async () => {
        try {
            const values = await form.validateFields();
            const normalizedGroupId =
                values.groupId === null ? null : toOptionalNumber(values.groupId);

            if (editingId) {
                const submitData = {
                    ...values,
                    groupId: normalizedGroupId ?? null,
                };
                const res = await emailApi.update(editingId, submitData);
                if (res.code === 200) {
                    message.success('更新成功');
                    setModalVisible(false);
                    fetchData();
                    fetchGroups();
                } else {
                    message.error(res.message);
                }
            } else {
                const submitData = {
                    ...values,
                    groupId: toOptionalNumber(values.groupId),
                };
                const res = await emailApi.create(submitData);
                if (res.code === 200) {
                    message.success('创建成功');
                    setModalVisible(false);
                    fetchData();
                    fetchGroups();
                } else {
                    message.error(res.message);
                }
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '保存失败'));
        }
    };

    const handleImport = async () => {
        if (!importContent.trim()) {
            message.warning('请输入或粘贴邮箱数据');
            return;
        }

        try {
            const res = await emailApi.import(
                importContent,
                separator,
                toOptionalNumber(importGroupId)
            );
            if (res.code === 200) {
                const syncQueued = Number((res.data as { syncQueued?: number } | undefined)?.syncQueued || 0);
                message.success(syncQueued > 0
                    ? `导入成功，已排队预拉取 ${syncQueued} 个邮箱`
                    : '导入成功');
                setImportModalVisible(false);
                setImportContent('');
                setImportGroupId(undefined);
                fetchData();
                fetchGroups();
            } else {
                message.error(res.message);
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '导入失败'));
        }
    };

    const handleExport = async () => {
        try {
            const ids = selectedRowKeys.length > 0 ? selectedRowKeys as number[] : undefined;
            const selectedGroupIds = ids ? [] : getSelectedGroupIds(filterGroupValues);
            const includeUngrouped = ids ? undefined : filterGroupValues.includes(UNGROUPED_FILTER_VALUE);
            const res = await emailApi.export(
                ids,
                separator,
                undefined,
                selectedGroupIds.length > 0 ? selectedGroupIds.join(',') : undefined,
                includeUngrouped
            );
            if (res.code !== 200) {
                message.error(res.message || '导出失败');
                return;
            }
            const content = res.data?.content || '';

            const blob = new Blob([content], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'email_accounts.txt';
            a.click();
            URL.revokeObjectURL(url);

            message.success('导出成功');
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '导出失败'));
        }
    };

    const loadMails = useCallback(async (
        emailId: number,
        mailbox: string,
        showSuccessToast: boolean = false,
        nextPage: number = 1,
        nextPageSize: number = 10
    ) => {
        if (mailLoadingRef.current) {
            return;
        }

        mailLoadingRef.current = true;
        setMailLoading(true);
        try {
            const result = await requestData<MailListResult>(
                () => emailApi.viewMails<MailItem>(emailId, mailbox, { page: nextPage, pageSize: nextPageSize }),
                '获取邮件失败'
            );
            if (result) {
                setMailList(result.messages || []);
                setMailTotal(result.total || 0);
                setMailPage(result.page || nextPage);
                setMailPageSize(result.pageSize || nextPageSize);
                if (showSuccessToast) {
                    message.success('本地邮件列表已刷新');
                }
            }
        } finally {
            mailLoadingRef.current = false;
            setMailLoading(false);
        }
    }, []);

    const handleViewMails = useCallback(async (record: EmailAccount, mailbox: string) => {
        if (mailLoadingRef.current) {
            return;
        }

        setCurrentEmail(record.email);
        setCurrentEmailId(record.id);
        setCurrentEmailGroupValue(record.groupId ?? UNGROUPED_FILTER_VALUE);
        setCurrentMailbox(mailbox);
        setMailList([]);
        setMailTotal(0);
        setMailPage(1);
        setMailPageSize(10);
        setMailModalVisible(true);
        await loadMails(record.id, mailbox, false, 1, 10);
    }, [loadMails]);

    const handleRefreshMails = async () => {
        if (!currentEmailId || mailLoadingRef.current) return;
        mailLoadingRef.current = true;
        setMailLoading(true);
        try {
            const result = await requestData<{
                fetched: number;
                inserted: number;
                updated: number;
                method: string;
            }>(
                () => emailApi.syncMails(currentEmailId, currentMailbox),
                '拉取最新邮件失败'
            );
            if (result) {
                message.success(`拉取完成：新增 ${result.inserted} 封，更新 ${result.updated} 封`);
                fetchData();
            }
        } finally {
            mailLoadingRef.current = false;
            setMailLoading(false);
        }
        await loadMails(currentEmailId, currentMailbox, false, 1, mailPageSize);
    };

    const handleClearMailbox = async () => {
        if (!currentEmailId) return;
        try {
            const res = await emailApi.clearMailbox(currentEmailId, currentMailbox);
            if (res.code === 200) {
                message.success(`已清空 ${res.data?.deletedCount || 0} 封邮件`);
                setMailList([]);
                setMailTotal(0);
                setMailPage(1);
                fetchData();
            } else {
                message.error(res.message || '清空失败');
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '清空失败'));
        }
    };

    // ========================================
    // Token refresh handlers
    // ========================================
    const handleRefreshToken = useCallback(async (record: EmailAccount) => {
        setRefreshingTokenIds(prev => new Set(prev).add(record.id));
        try {
            const res = await emailApi.refreshSingleToken(record.id);
            if (res.code === 200 && res.data?.success) {
                message.success(`${record.email} Token 刷新成功`);
                fetchData();
            } else {
                message.error(res.data?.message || 'Token 刷新失败');
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, 'Token 刷新失败'));
        } finally {
            setRefreshingTokenIds(prev => {
                const next = new Set(prev);
                next.delete(record.id);
                return next;
            });
        }
    }, [fetchData]);

    const handleCheckVerification = useCallback(async (record: EmailAccount) => {
        setCheckingEmailIds(prev => new Set(prev).add(record.id));
        try {
            const res = await emailApi.checkVerification(record.id);
            if (res.code !== 200 || !res.data) {
                message.error(res.message || '检查失败');
                return;
            }

            if (res.data.status === 'DEACTIVATED') {
                message.warning(`${record.email} 已被禁用，已加入“禁用”分组`);
                fetchData();
                fetchGroups();
                return;
            }

            if (res.data.status === 'CODE_FOUND' && res.data.code) {
                try {
                    await copyTextToClipboard(res.data.code);
                    message.success(`验证码 ${res.data.code} 已复制到剪切板`);
                } catch {
                    message.warning(`验证码 ${res.data.code} 已识别，复制到剪切板失败`);
                }
                fetchData();
                return;
            }

            message.warning('最后一封邮件未匹配到验证码');
            fetchData();
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '检查失败或已超时'));
        } finally {
            setCheckingEmailIds(prev => {
                const next = new Set(prev);
                next.delete(record.id);
                return next;
            });
        }
    }, [fetchData, fetchGroups]);

    const handleBatchRefreshTokens = async () => {
        setBatchRefreshing(true);
        try {
            const selectedGroupIds = getSelectedGroupIds(filterGroupValues);
            const singleGroupId = selectedGroupIds.length === 1 && !filterGroupValues.includes(UNGROUPED_FILTER_VALUE)
                ? selectedGroupIds[0]
                : undefined;
            const res = await emailApi.refreshTokens(singleGroupId);
            if (res.code === 200) {
                message.success('批量 Token 刷新任务已启动，请稍后刷新页面查看结果');
            } else {
                message.error(res.message || '启动失败');
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '启动失败'));
        } finally {
            setBatchRefreshing(false);
        }
    };

    const handleViewEmailDetail = async (record: MailItem) => {
        if (!currentEmailId) return;
        setEmailDetailSubject(record.subject || '无主题');
        setEmailDetailContent(renderPlainTextEmail('加载中...'));
        setEmailDetailVisible(true);
        setEmailDetailLoading(true);
        try {
            const result = await requestData<MailDetail>(
                () => emailApi.getMailDetail<MailDetail>(currentEmailId, record.id),
                '获取邮件详情失败'
            );
            if (result) {
                setEmailDetailSubject(result.subject || '无主题');
                setEmailDetailContent(result.html || renderPlainTextEmail(result.text || '无内容'));
            }
        } finally {
            setEmailDetailLoading(false);
        }
    };

    const handleMailGroupChange = useCallback(async (value: GroupFilterValue) => {
        if (!currentEmailId || mailGroupUpdating) return;

        setMailGroupUpdating(true);
        try {
            const groupId = value === UNGROUPED_FILTER_VALUE ? null : value;
            const res = await emailApi.update(currentEmailId, { groupId });
            if (res.code === 200) {
                setCurrentEmailGroupValue(value);
                message.success(value === UNGROUPED_FILTER_VALUE ? '已设为未分组' : '邮箱分组已更新');
                fetchData();
                fetchGroups();
            } else {
                message.error(res.message || '更新分组失败');
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '更新分组失败'));
        } finally {
            setMailGroupUpdating(false);
        }
    }, [currentEmailId, fetchData, fetchGroups, mailGroupUpdating]);

    // ========================================
    // Group CRUD handlers
    // ========================================
    const handleCreateGroup = () => {
        setEditingGroupId(null);
        groupForm.resetFields();
        groupForm.setFieldsValue({ fetchStrategy: 'IMAP_FIRST' });
        setGroupModalVisible(true);
    };

    const handleEditGroup = useCallback((group: EmailGroup) => {
        setEditingGroupId(group.id);
        groupForm.setFieldsValue({
            name: group.name,
            description: group.description,
            fetchStrategy: group.fetchStrategy,
        });
        setGroupModalVisible(true);
    }, [groupForm]);

    const handleDeleteGroup = useCallback(async (id: number) => {
        try {
            const res = await groupApi.delete(id);
            if (res.code === 200) {
                message.success('分组已删除');
                fetchGroups();
                fetchData();
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '删除失败'));
        }
    }, [fetchData, fetchGroups]);

    const handleGroupSubmit = async () => {
        try {
            const values = await groupForm.validateFields();
            if (editingGroupId) {
                const res = await groupApi.update(editingGroupId, values);
                if (res.code === 200) {
                    message.success('分组已更新');
                    setGroupModalVisible(false);
                    fetchGroups();
                }
            } else {
                const res = await groupApi.create(values);
                if (res.code === 200) {
                    message.success('分组已创建');
                    setGroupModalVisible(false);
                    fetchGroups();
                }
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '分组保存失败'));
        }
    };

    const handleBatchAssignGroup = async () => {
        if (selectedRowKeys.length === 0) {
            message.warning('请先选择邮箱');
            return;
        }
        if (!assignTargetGroupId) {
            message.warning('请选择目标分组');
            return;
        }
        try {
            const res = await groupApi.assignEmails(assignTargetGroupId, selectedRowKeys as number[]);
            if (res.code === 200) {
                message.success(`已将 ${res.data.count} 个邮箱分配到分组`);
                setAssignGroupModalVisible(false);
                setAssignTargetGroupId(undefined);
                setSelectedRowKeys([]);
                fetchData();
                fetchGroups();
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '分配失败'));
        }
    };

    const handleBatchRemoveGroup = async () => {
        if (selectedRowKeys.length === 0) {
            message.warning('请先选择邮箱');
            return;
        }
        // Find the groupIds of selected emails, remove from each group
        const selectedEmails = data.filter((e: EmailAccount) => selectedRowKeys.includes(e.id));
        const groupIds = [...new Set(selectedEmails.map((e: EmailAccount) => e.groupId).filter(Boolean))] as number[];

        try {
            for (const gid of groupIds) {
                const emailIds = selectedEmails.filter((e: EmailAccount) => e.groupId === gid).map((e: EmailAccount) => e.id);
                await groupApi.removeEmails(gid, emailIds);
            }
            message.success('已将选中邮箱移出分组');
            setSelectedRowKeys([]);
            fetchData();
            fetchGroups();
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '移出失败'));
        }
    };

    // ========================================
    // Email table columns
    // ========================================
    const columns: ColumnsType<EmailAccount> = useMemo(() => [
        {
            title: '邮箱',
            dataIndex: 'email',
            key: 'email',
            width: 360,
            render: (email: string) => (
                <div className="email-account-cell">
                    <Text className="email-account-address" ellipsis={{ tooltip: email }}>
                        {email}
                    </Text>
                    <Tooltip title="复制邮箱">
                        <Button
                            type="text"
                            size="small"
                            className="email-account-copy"
                            aria-label={`复制邮箱 ${email}`}
                            icon={<CopyOutlined />}
                            onClick={async (event) => {
                                event.stopPropagation();
                                try {
                                    await copyTextToClipboard(email);
                                    message.success('邮箱已复制');
                                } catch {
                                    message.warning('复制邮箱失败');
                                }
                            }}
                        />
                    </Tooltip>
                </div>
            ),
        },
        {
            title: '分组',
            dataIndex: 'group',
            key: 'group',
            width: 120,
            render: (group: EmailAccount['group']) =>
                group ? <Tag color="blue">{group.name}</Tag> : <Tag>未分组</Tag>,
        },
        {
            title: '状态',
            dataIndex: 'status',
            key: 'status',
            width: 100,
            render: (status: string) => {
                const colors: Record<string, string> = {
                    ACTIVE: 'green',
                    ERROR: 'red',
                    DISABLED: 'default',
                };
                const labels: Record<string, string> = {
                    ACTIVE: '正常',
                    ERROR: '异常',
                    DISABLED: '禁用',
                };
                return <Tag color={colors[status]}>{labels[status]}</Tag>;
            },
        },
        {
            title: '最后检查',
            dataIndex: 'lastCheckAt',
            key: 'lastCheckAt',
            width: 160,
            render: (val: string | null) => (val ? dayjs(val).format('YYYY-MM-DD HH:mm') : '-'),
        },
        {
            title: 'Token 刷新',
            dataIndex: 'tokenRefreshedAt',
            key: 'tokenRefreshedAt',
            width: 160,
            render: (val: string | null) => (val ? dayjs(val).format('YYYY-MM-DD HH:mm') : '-'),
        },
        {
            title: '验证码',
            key: 'verification',
            width: 180,
            render: (_: unknown, record: EmailAccount) => (
                <Space direction="vertical" size={0}>
                    {record.lastVerificationCode ? (
                        <Typography.Text code>{record.lastVerificationCode}</Typography.Text>
                    ) : (
                        <Typography.Text type="secondary">-</Typography.Text>
                    )}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {record.lastVerificationMailAt
                            ? `发送：${dayjs(record.lastVerificationMailAt).format('YYYY-MM-DD HH:mm')}`
                            : record.lastVerificationCheckedAt
                                ? `检查：${dayjs(record.lastVerificationCheckedAt).format('YYYY-MM-DD HH:mm')}`
                                : ''}
                    </Typography.Text>
                </Space>
            ),
        },
        {
            title: '创建时间',
            dataIndex: 'createdAt',
            key: 'createdAt',
            width: 160,
            render: (val: string) => dayjs(val).format('YYYY-MM-DD HH:mm'),
        },
        {
            title: '操作',
            key: 'action',
            width: 280,
            render: (_: unknown, record: EmailAccount) => {
                const isChecking = checkingEmailIds.has(record.id);
                const isRefreshing = refreshingTokenIds.has(record.id);
                const rowBusy = isChecking || isRefreshing;
                const disabled = rowBusy || record.status === 'DISABLED';

                return (
                    <Space>
                        <Tooltip title="检查验证码">
                            <Button
                                type="text"
                                icon={<CheckCircleOutlined spin={isChecking} />}
                                onClick={() => handleCheckVerification(record)}
                                disabled={disabled}
                            />
                        </Tooltip>
                        <Tooltip title="刷新 Token">
                            <Button
                                type="text"
                                icon={<SyncOutlined spin={isRefreshing} />}
                                onClick={() => handleRefreshToken(record)}
                                disabled={disabled}
                            />
                        </Tooltip>
                        <Tooltip title="收件箱">
                            <Button
                                type="text"
                                icon={<MailOutlined />}
                                onClick={() => handleViewMails(record, 'INBOX')}
                                disabled={disabled || mailLoading}
                            />
                        </Tooltip>
                        <Tooltip title="垃圾箱">
                            <Button
                                type="text"
                                icon={<DeleteOutlined style={{ color: '#faad14' }} />}
                                onClick={() => handleViewMails(record, 'Junk')}
                                disabled={disabled || mailLoading}
                            />
                        </Tooltip>
                        <Tooltip title="编辑">
                            <Button
                                type="text"
                                icon={<EditOutlined />}
                                onClick={() => handleEdit(record)}
                                disabled={rowBusy}
                            />
                        </Tooltip>
                        <Tooltip title="删除">
                            <Popconfirm
                                title="确定要删除此邮箱吗？"
                                onConfirm={() => handleDelete(record.id)}
                                disabled={rowBusy}
                            >
                                <Button type="text" danger icon={<DeleteOutlined />} disabled={rowBusy} />
                            </Popconfirm>
                        </Tooltip>
                    </Space>
                );
            },
        },
    ], [checkingEmailIds, handleCheckVerification, handleDelete, handleEdit, handleRefreshToken, handleViewMails, mailLoading, refreshingTokenIds]);

    const rowSelection = useMemo(
        () => ({
            selectedRowKeys,
            onChange: setSelectedRowKeys,
            columnWidth: 48,
            getCheckboxProps: (record: EmailAccount) => ({
                disabled: checkingEmailIds.has(record.id),
            }),
        }),
        [checkingEmailIds, selectedRowKeys]
    );

    const tablePagination = useMemo(
        () => ({
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (count: number) => `共 ${count} 条`,
            onChange: (currentPage: number, currentPageSize: number) => {
                setPage(currentPage);
                setPageSize(currentPageSize);
            },
        }),
        [page, pageSize, total]
    );

    const emailDetailSrcDoc = useMemo(
        () => `
                        <!DOCTYPE html>
                        <html>
                        <head>
                            <meta charset="utf-8">
                            <style>
                                body { 
                                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                                    font-size: 14px;
                                    line-height: 1.6;
                                    color: #333;
                                    margin: 0;
                                    padding: 16px;
                                    background: #fafafa;
                                }
                                img { max-width: 100%; height: auto; }
                                a { color: #1890ff; }
                            </style>
                        </head>
                        <body>${emailDetailContent}</body>
                        </html>
                    `,
        [emailDetailContent]
    );

    const groupFilterOptions = useMemo(
        () => [
            {
                value: UNGROUPED_FILTER_VALUE,
                label: '未分组',
            },
            ...groups.map((group: EmailGroup) => ({
                value: group.id,
                label: `${group.name} (${group.emailCount})`,
            })),
        ],
        [groups]
    );

    const groupOptions = useMemo(
        () =>
            groups.map((group: EmailGroup) => ({
                value: group.id,
                label: group.name,
            })),
        [groups]
    );

    const mailGroupOptions = useMemo(
        () => [
            { value: UNGROUPED_FILTER_VALUE, label: '未分组' },
            ...groupOptions,
        ],
        [groupOptions]
    );

    // ========================================
    // Group table columns
    // ========================================
    const groupColumns: ColumnsType<EmailGroup> = useMemo(() => [
        {
            title: '分组名称',
            dataIndex: 'name',
            key: 'name',
            render: (name: string) => <Tag color="blue">{name}</Tag>,
        },
        {
            title: '描述',
            dataIndex: 'description',
            key: 'description',
            render: (val: string | null) => val || '-',
        },
        {
            title: '拉取策略',
            dataIndex: 'fetchStrategy',
            key: 'fetchStrategy',
            width: 190,
            render: (value: MailFetchStrategy) => <Tag color="purple">{MAIL_FETCH_STRATEGY_LABELS[value]}</Tag>,
        },
        {
            title: '邮箱数',
            dataIndex: 'emailCount',
            key: 'emailCount',
            width: 100,
        },
        {
            title: '创建时间',
            dataIndex: 'createdAt',
            key: 'createdAt',
            width: 180,
            render: (val: string) => dayjs(val).format('YYYY-MM-DD HH:mm'),
        },
        {
            title: '操作',
            key: 'action',
            width: 160,
            render: (_: unknown, record: EmailGroup) => (
                <Space>
                    <Button
                        type="text"
                        icon={<EditOutlined />}
                        onClick={() => handleEditGroup(record)}
                    />
                    <Popconfirm
                        title="删除分组后，组内邮箱将变为「未分组」。确认？"
                        onConfirm={() => handleDeleteGroup(record.id)}
                    >
                        <Button type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                </Space>
            ),
        },
    ], [handleDeleteGroup, handleEditGroup]);

    // ========================================
    // Render
    // ========================================
    return (
        <div>
            <Title level={4} style={{ margin: '0 0 16px' }}>邮箱管理</Title>
            <Tabs
                defaultActiveKey="emails"
                animated={false}
                destroyInactiveTabPane
                items={[
                    {
                        key: 'emails',
                        label: '邮箱列表',
                        children: (
                            <>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
                                    <Space wrap>
                                        <Input
                                            placeholder="搜索邮箱"
                                            prefix={<SearchOutlined />}
                                            value={keyword}
                                            onChange={(e) => setKeyword(e.target.value)}
                                            style={{ width: 200 }}
                                            allowClear
                                        />
                                        <Select
                                            placeholder="按分组筛选"
                                            allowClear
                                            mode="multiple"
                                            maxTagCount="responsive"
                                            style={{ width: 220 }}
                                            value={filterGroupValues}
                                            options={groupFilterOptions}
                                            onChange={(vals: GroupFilterValue[]) => {
                                                setFilterGroupValues(vals);
                                                setPage(1);
                                            }}
                                        />
                                    </Space>
                                    <Space wrap>
                                        <Button
                                            icon={<SyncOutlined spin={batchRefreshing} />}
                                            onClick={handleBatchRefreshTokens}
                                            loading={batchRefreshing}
                                        >
                                            刷新全部 Token
                                        </Button>
                                        <Button icon={<UploadOutlined />} onClick={() => setImportModalVisible(true)}>
                                            导入
                                        </Button>
                                        <Button icon={<DownloadOutlined />} onClick={handleExport}>
                                            导出
                                        </Button>
                                        {selectedRowKeys.length > 0 && (
                                            <>
                                                <Button icon={<GroupOutlined />} onClick={() => setAssignGroupModalVisible(true)}>
                                                    分配分组 ({selectedRowKeys.length})
                                                </Button>
                                                <Button onClick={handleBatchRemoveGroup}>
                                                    移出分组 ({selectedRowKeys.length})
                                                </Button>
                                                <Popconfirm
                                                    title={`确定要删除选中的 ${selectedRowKeys.length} 个邮箱吗？`}
                                                    onConfirm={handleBatchDelete}
                                                >
                                                    <Button danger>批量删除 ({selectedRowKeys.length})</Button>
                                                </Popconfirm>
                                            </>
                                        )}
                                        <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
                                            添加邮箱
                                        </Button>
                                    </Space>
                                </div>

                                <Table
                                    className="email-account-table"
                                    columns={columns}
                                    dataSource={data}
                                    rowKey="id"
                                    loading={loading}
                                    rowSelection={rowSelection}
                                    pagination={tablePagination}
                                    virtual
                                    scroll={{ y: 560, x: 1080 }}
                                />
                            </>
                        ),
                    },
                    {
                        key: 'groups',
                        label: '邮箱分组',
                        children: (
                            <>
                                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
                                    <Button type="primary" icon={<PlusOutlined />} onClick={handleCreateGroup}>
                                        创建分组
                                    </Button>
                                </div>
                                <Table
                                    columns={groupColumns}
                                    dataSource={groups}
                                    rowKey="id"
                                    pagination={false}
                                />
                            </>
                        ),
                    },
                ]}
            />

            {/* 添加/编辑邮箱 Modal */}
            <Modal
                title={editingId ? '编辑邮箱' : '添加邮箱'}
                open={modalVisible}
                onOk={handleSubmit}
                onCancel={() => setModalVisible(false)}
                destroyOnClose
                width={600}
            >
                <Spin spinning={emailEditLoading}>
                    <Form form={form} layout="vertical">
                    <Form.Item name="email" label="邮箱地址" rules={[{ required: true, message: '请输入邮箱地址' }, { type: 'email', message: '请输入有效的邮箱地址' }]}>
                        <Input placeholder="example@outlook.com" />
                    </Form.Item>
                    <Form.Item name="password" label="密码">
                        <Input.Password placeholder="可选" />
                    </Form.Item>

                    <Form.Item
                        name="clientId"
                        label="客户端 ID"
                        rules={[{ required: true, message: '请输入客户端 ID' }]}
                    >
                        <Input placeholder="Azure AD 应用程序 ID" />
                    </Form.Item>
                    <Form.Item
                        name="refreshToken"
                        label="刷新令牌"
                        rules={[{ required: !editingId, message: '请输入刷新令牌' }]}
                    >
                        <TextArea rows={4} placeholder="OAuth2 Refresh Token" />
                    </Form.Item>
                    <Form.Item name="groupId" label="所属分组">
                        <Select placeholder="可选：选择分组" allowClear options={groupOptions} />
                    </Form.Item>
                    <Form.Item name="status" label="状态" initialValue="ACTIVE">
                        <Select>
                            <Select.Option value="ACTIVE">正常</Select.Option>
                            <Select.Option value="DISABLED">禁用</Select.Option>
                        </Select>
                    </Form.Item>
                    </Form>
                </Spin>
            </Modal>

            {/* 批量导入 Modal */}
            <Modal
                title="批量导入邮箱"
                open={importModalVisible}
                onOk={handleImport}
                onCancel={() => setImportModalVisible(false)}
                destroyOnClose
                width={700}
            >
                <Space direction="vertical" style={{ width: '100%' }} size="middle">
                    <div>
                        <Text type="secondary">
                            上传文件或粘贴内容。支持多种格式，将尝试自动解析。
                            <br />
                            推荐格式：邮箱{separator}密码{separator}客户端ID{separator}刷新令牌
                        </Text>
                    </div>
                    <Input
                        addonBefore="分隔符"
                        value={separator}
                        onChange={(e) => setSeparator(e.target.value)}
                        style={{ width: 200 }}
                    />
                    <Select
                        placeholder="导入到分组（可选）"
                        allowClear
                        value={importGroupId}
                        options={groupOptions}
                        onChange={(value: number | string | undefined) => setImportGroupId(toOptionalNumber(value))}
                        style={{ width: 260 }}
                    />
                    <Dragger
                        beforeUpload={(file) => {
                            const reader = new FileReader();
                            reader.onload = (e) => {
                                const fileContent = e.target?.result as string;
                                if (fileContent) {
                                    const lines = fileContent.split(/\r?\n/).filter((line: string) => line.trim());
                                    const processedLines = lines.map((line: string) => {
                                        const parts = line.split(separator);
                                        if (parts.length >= 5) {
                                            return `${parts[0]}${separator}${parts[1]}${separator}${parts[4]}`;
                                        }
                                        return line;
                                    });

                                    setImportContent(processedLines.join('\n'));
                                    message.success(`文件读取成功，已解析 ${lines.length} 行数据`);
                                }
                            };
                            reader.readAsText(file);
                            return false;
                        }}
                        showUploadList={false}
                        maxCount={1}
                        accept=".txt,.csv"
                    >
                        <p className="ant-upload-drag-icon">
                            <InboxOutlined />
                        </p>
                        <p className="ant-upload-text">点击或拖拽文件到此区域</p>
                        <p className="ant-upload-hint">支持 .txt 或 .csv 文件</p>
                    </Dragger>
                    <TextArea
                        rows={12}
                        value={importContent}
                        onChange={(e) => setImportContent(e.target.value)}
                        placeholder={`example@outlook.com${separator}client_id${separator}refresh_token`}
                    />
                </Space>
            </Modal>

            {/* 邮件列表 Modal */}
            {mailModalVisible && (
                <Modal
                    title={`${currentEmail} 的${currentMailbox === 'INBOX' ? '收件箱' : '垃圾箱'}`}
                    open={mailModalVisible}
                    onCancel={() => setMailModalVisible(false)}
                    footer={null}
                    destroyOnClose
                    width={1000}
                    styles={{ body: { padding: '16px 24px' } }}
                >
                    <Space style={{ marginBottom: 16 }} wrap>
                        <Button type="primary" onClick={handleRefreshMails} loading={mailLoading} disabled={mailLoading}>
                            拉取最新邮件
                        </Button>
                        <Popconfirm
                            title={`确定要清空${currentMailbox === 'INBOX' ? '收件箱' : '垃圾箱'}的所有邮件吗？`}
                            onConfirm={handleClearMailbox}
                        >
                            <Button danger disabled={mailLoading}>清空</Button>
                        </Popconfirm>
                        <Select
                            value={currentEmailGroupValue}
                            options={mailGroupOptions}
                            onChange={(value: GroupFilterValue) => {
                                void handleMailGroupChange(value);
                            }}
                            loading={mailGroupUpdating}
                            disabled={mailGroupUpdating}
                            style={{ width: 180 }}
                            placeholder="修改分组"
                        />
                        <span style={{ marginLeft: 16, color: '#888' }}>
                            本地共 {mailTotal} 封邮件
                        </span>
                    </Space>
                    <List
                        loading={mailLoading}
                        dataSource={mailList}
                        itemLayout="horizontal"
                        style={{ maxHeight: 450, overflow: 'auto' }}
                        renderItem={(item: MailItem) => (
                            <List.Item
                                key={item.id}
                                actions={[
                                    <Button
                                        type="primary"
                                        size="small"
                                        onClick={() => handleViewEmailDetail(item)}
                                    >
                                        查看
                                    </Button>,
                                ]}
                            >
                                <List.Item.Meta
                                    title={
                                        <Space>
                                            {item.isNew && <Tag color="green">新拉取</Tag>}
                                            <Typography.Text ellipsis style={{ maxWidth: 620 }}>
                                                {item.subject || '(无主题)'}
                                            </Typography.Text>
                                        </Space>
                                    }
                                    description={
                                        <Space direction="vertical" size={4}>
                                            <Space size="large" wrap>
                                                <span style={{ color: '#1890ff' }}>{item.from || '未知发件人'}</span>
                                                <span style={{ color: '#999' }}>
                                                    发送：{item.sentAt ? dayjs(item.sentAt).format('YYYY-MM-DD HH:mm') : '-'}
                                                </span>
                                                <span style={{ color: '#999' }}>
                                                    拉取：{item.lastFetchedAt ? dayjs(item.lastFetchedAt).format('YYYY-MM-DD HH:mm') : '-'}
                                                </span>
                                            </Space>
                                            <Typography.Text type="secondary" ellipsis style={{ maxWidth: 760 }}>
                                                {item.bodyPreview || '无摘要'}
                                            </Typography.Text>
                                        </Space>
                                    }
                                />
                            </List.Item>
                        )}
                    />
                    {mailTotal > 0 && (
                        <Pagination
                            current={mailPage}
                            pageSize={mailPageSize}
                            total={mailTotal}
                            showSizeChanger
                            showQuickJumper
                            showTotal={(count: number) => `共 ${count} 条`}
                            style={{ marginTop: 16, textAlign: 'right' }}
                            onChange={(nextPage: number, nextPageSize: number) => {
                                if (currentEmailId) {
                                    loadMails(currentEmailId, currentMailbox, false, nextPage, nextPageSize);
                                }
                            }}
                        />
                    )}
                </Modal>
            )}

            {/* 邮件详情 Modal */}
            {emailDetailVisible && (
                <Modal
                    title={emailDetailSubject}
                    open={emailDetailVisible}
                    onCancel={() => setEmailDetailVisible(false)}
                    footer={null}
                    destroyOnClose
                    width={900}
                    styles={{ body: { padding: '16px 24px' } }}
                >
                    <Spin spinning={emailDetailLoading}>
                        <iframe
                            title="email-content"
                            sandbox="allow-same-origin"
                            srcDoc={emailDetailSrcDoc}
                            style={{
                                width: '100%',
                                height: 'calc(100vh - 300px)',
                                border: '1px solid #eee',
                                borderRadius: '8px',
                                backgroundColor: '#fafafa',
                            }}
                        />
                    </Spin>
                </Modal>
            )}

            {/* 创建/编辑分组 Modal */}
            <Modal
                title={editingGroupId ? '编辑分组' : '创建分组'}
                open={groupModalVisible}
                onOk={handleGroupSubmit}
                onCancel={() => setGroupModalVisible(false)}
                destroyOnClose
                width={460}
            >
                <Form form={groupForm} layout="vertical">
                    <Form.Item name="name" label="分组名称" rules={[{ required: true, message: '请输入分组名称' }]}>
                        <Input placeholder="例如：aws、discord" />
                    </Form.Item>
                    <Form.Item name="description" label="描述">
                        <Input placeholder="可选描述" />
                    </Form.Item>
                    <Form.Item
                        name="fetchStrategy"
                        label="邮件拉取策略"
                        rules={[{ required: true, message: '请选择拉取策略' }]}
                    >
                        <Select options={MAIL_FETCH_STRATEGY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))} />
                    </Form.Item>
                </Form>
            </Modal>

            {/* 批量分配分组 Modal */}
            <Modal
                title="分配邮箱到分组"
                open={assignGroupModalVisible}
                onOk={handleBatchAssignGroup}
                onCancel={() => setAssignGroupModalVisible(false)}
                destroyOnClose
                width={400}
            >
                <p>已选择 {selectedRowKeys.length} 个邮箱</p>
                <Select
                    placeholder="选择目标分组"
                    style={{ width: '100%' }}
                    value={assignTargetGroupId}
                    options={groupOptions}
                    onChange={setAssignTargetGroupId}
                />
            </Modal>
        </div>
    );
};

export default EmailsPage;
