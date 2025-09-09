import { 
  collection, 
  doc, 
  getDocs, 
  getDoc, 
  addDoc, 
  updateDoc, 
  query, 
  where, 
  orderBy,
  serverTimestamp,
  onSnapshot,
  writeBatch
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { SupportTicket, TicketResponse, TicketAction } from '../types/supportTicket';

export class SupportTicketService {
  // Create a new support ticket
  static async createTicket(ticketData: Omit<SupportTicket, 'id' | 'submittedAt' | 'responses' | 'lastActivity'>): Promise<string> {
    try {
      console.log('🎫 Creating support ticket:', ticketData.subject);
      
      const ticket = {
        ...ticketData,
        submittedAt: serverTimestamp(),
        responses: [],
        lastActivity: serverTimestamp(),
        escalated: false,
        tags: [],
        attachments: []
      };
      
      const docRef = await addDoc(collection(db, 'supportTickets'), ticket);
      
      // Log ticket creation action
      await this.logTicketAction(
        docRef.id,
        'created',
        ticketData.submittedBy,
        ticketData.submittedByName,
        { ticketType: ticketData.ticketType, priority: ticketData.priority }
      );
      
      console.log('✅ Support ticket created:', docRef.id);
      return docRef.id;
    } catch (error) {
      console.error('❌ Error creating support ticket:', error);
      throw new Error(`Failed to create support ticket: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Get all support tickets
  static async getAllTickets(): Promise<SupportTicket[]> {
    try {
      console.log('🎫 Fetching all support tickets...');
      
      const ticketsQuery = query(
        collection(db, 'supportTickets'),
        orderBy('lastActivity', 'desc')
      );
      
      const querySnapshot = await getDocs(ticketsQuery);
      
      const tickets = querySnapshot.docs.map(doc => {
        const data = doc.data();
        return {
          id: doc.id,
          ...data,
          submittedAt: data.submittedAt?.toDate() || new Date(),
          assignedAt: data.assignedAt?.toDate() || null,
          resolvedAt: data.resolvedAt?.toDate() || null,
          closedAt: data.closedAt?.toDate() || null,
          lastActivity: data.lastActivity?.toDate() || new Date(),
          escalatedAt: data.escalatedAt?.toDate() || null,
          responses: data.responses?.map((response: any) => ({
            ...response,
            timestamp: response.timestamp?.toDate() || new Date()
          })) || []
        };
      }) as SupportTicket[];
      
      console.log(`✅ Retrieved ${tickets.length} support tickets`);
      return tickets;
    } catch (error) {
      console.error('❌ Error fetching support tickets:', error);
      throw new Error(`Failed to load support tickets: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Real-time listener for support tickets
  static subscribeToTickets(callback: (tickets: SupportTicket[]) => void): () => void {
    console.log('🔄 Setting up real-time listener for support tickets...');
    
    const ticketsQuery = query(
      collection(db, 'supportTickets'),
      orderBy('lastActivity', 'desc')
    );
    
    const unsubscribe = onSnapshot(
      ticketsQuery,
      (querySnapshot) => {
        console.log('🔄 Support tickets updated in real-time');
        const tickets = querySnapshot.docs.map(doc => {
          const data = doc.data();
          return {
            id: doc.id,
            ...data,
            submittedAt: data.submittedAt?.toDate() || new Date(),
            assignedAt: data.assignedAt?.toDate() || null,
            resolvedAt: data.resolvedAt?.toDate() || null,
            closedAt: data.closedAt?.toDate() || null,
            lastActivity: data.lastActivity?.toDate() || new Date(),
            escalatedAt: data.escalatedAt?.toDate() || null,
            responses: data.responses?.map((response: any) => ({
              ...response,
              timestamp: response.timestamp?.toDate() || new Date()
            })) || []
          };
        }) as SupportTicket[];
        
        callback(tickets);
      },
      (error) => {
        console.error('❌ Real-time listener failed for support tickets:', error);
        callback([]);
      }
    );

    return unsubscribe;
  }

  // Add response to ticket
  static async addTicketResponse(
    ticketId: string,
    responderId: string,
    responderName: string,
    responderRole: 'admin' | 'governor',
    content: string,
    isInternal: boolean = false
  ): Promise<void> {
    try {
      console.log('🎫 Adding response to ticket:', ticketId);
      
      const ticketRef = doc(db, 'supportTickets', ticketId);
      const ticketDoc = await getDoc(ticketRef);
      
      if (!ticketDoc.exists()) {
        throw new Error('Ticket not found');
      }
      
      const ticketData = ticketDoc.data();
      const newResponse: TicketResponse = {
        id: `response_${Date.now()}`,
        ticketId,
        responderId,
        responderName,
        responderRole,
        content,
        timestamp: new Date(),
        isInternal
      };
      
      const updatedResponses = [...(ticketData.responses || []), {
        ...newResponse,
      }];
      
      await updateDoc(ticketRef, {
        responses: updatedResponses,
        lastActivity: serverTimestamp(),
        status: responderRole === 'governor' && ticketData.status === 'open' ? 'in_progress' : ticketData.status
      });
      
      // Log response action
      await this.logTicketAction(
        ticketId,
        'responded',
        responderId,
        responderName,
        { responseLength: content.length, isInternal }
      );
      
      console.log('✅ Response added to ticket');
    } catch (error) {
      console.error('❌ Error adding ticket response:', error);
      throw new Error(`Failed to add response: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Update ticket status
  static async updateTicketStatus(
    ticketId: string,
    newStatus: SupportTicket['status'],
    governorId: string,
    governorName: string,
    resolution?: string
  ): Promise<void> {
    try {
      console.log(`🎫 Updating ticket ${ticketId} status to ${newStatus}`);
      
      const ticketRef = doc(db, 'supportTickets', ticketId);
      const updateData: any = {
        status: newStatus,
        lastActivity: serverTimestamp()
      };
      
      if (newStatus === 'resolved' && resolution) {
        updateData.resolution = resolution;
        updateData.resolvedAt = serverTimestamp();
        updateData.resolvedBy = governorId;
      }
      
      if (newStatus === 'closed') {
        updateData.closedAt = serverTimestamp();
        updateData.closedBy = governorId;
      }
      
      await updateDoc(ticketRef, updateData);
      
      // Log status change action
      await this.logTicketAction(
        ticketId,
        'status_changed',
        governorId,
        governorName,
        { oldStatus: 'previous', newStatus, resolution }
      );
      
      console.log('✅ Ticket status updated');
    } catch (error) {
      console.error('❌ Error updating ticket status:', error);
      throw new Error(`Failed to update ticket status: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Assign ticket to governor
  static async assignTicket(
    ticketId: string,
    assigneeId: string,
    assigneeName: string,
    assignedBy: string,
    assignedByName: string
  ): Promise<void> {
    try {
      console.log(`🎫 Assigning ticket ${ticketId} to ${assigneeName}`);
      
      const ticketRef = doc(db, 'supportTickets', ticketId);
      await updateDoc(ticketRef, {
        assignedTo: assigneeId,
        assignedToName: assigneeName,
        assignedAt: serverTimestamp(),
        status: 'in_progress',
        lastActivity: serverTimestamp()
      });
      
      // Log assignment action
      await this.logTicketAction(
        ticketId,
        'assigned',
        assignedBy,
        assignedByName,
        { assignedTo: assigneeName }
      );
      
      console.log('✅ Ticket assigned successfully');
    } catch (error) {
      console.error('❌ Error assigning ticket:', error);
      throw new Error(`Failed to assign ticket: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Escalate ticket
  static async escalateTicket(
    ticketId: string,
    reason: string,
    escalatedBy: string,
    escalatedByName: string
  ): Promise<void> {
    try {
      console.log(`🎫 Escalating ticket ${ticketId}`);
      
      const ticketRef = doc(db, 'supportTickets', ticketId);
      await updateDoc(ticketRef, {
        escalated: true,
        escalatedAt: serverTimestamp(),
        escalatedReason: reason,
        priority: 'urgent',
        lastActivity: serverTimestamp()
      });
      
      // Log escalation action
      await this.logTicketAction(
        ticketId,
        'escalated',
        escalatedBy,
        escalatedByName,
        { reason }
      );
      
      console.log('✅ Ticket escalated successfully');
    } catch (error) {
      console.error('❌ Error escalating ticket:', error);
      throw new Error(`Failed to escalate ticket: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Log ticket action
  static async logTicketAction(
    ticketId: string,
    actionType: TicketAction['actionType'],
    performedBy: string,
    performedByName: string,
    details: Record<string, any>
  ): Promise<void> {
    try {
      await addDoc(collection(db, 'ticketActions'), {
        ticketId,
        actionType,
        performedBy,
        performedByName,
        timestamp: serverTimestamp(),
        details
      });
    } catch (error) {
      console.error('❌ Error logging ticket action:', error);
    }
  }

  // Get ticket actions (audit trail)
  static async getTicketActions(ticketId: string): Promise<TicketAction[]> {
    try {
      const actionsQuery = query(
        collection(db, 'ticketActions'),
        where('ticketId', '==', ticketId),
        orderBy('timestamp', 'asc')
      );
      
      const querySnapshot = await getDocs(actionsQuery);
      
      return querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        timestamp: doc.data().timestamp?.toDate() || new Date()
      })) as TicketAction[];
    } catch (error) {
      console.error('❌ Error fetching ticket actions:', error);
      throw error;
    }
  }
}